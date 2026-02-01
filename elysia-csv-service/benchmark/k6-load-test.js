/**
 * k6 Load Test for CSV Processing Services
 * Tests both Hono and Elysia implementations
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  honoBaseUrl: __ENV.HONO_BASE_URL || 'http://localhost:3000',
  elysiaBaseUrl: __ENV.ELYCIA_BASE_URL || 'http://localhost:3001',
  testDuration: __ENV.TEST_DURATION || '30s',
  targetVUs: parseInt(__ENV.TARGET_VUS || '500'),
  stagingDuration: __ENV.STAGING_DURATION || '5s',
  csvFilePath: __ENV.CSV_FILE_PATH || './data/sample-100k.csv',
  jwtToken: __ENV.JWT_TOKEN || '',
  apiKey: __ENV.API_KEY || '',
};

// ============================================================================
// Custom Metrics
// ============================================================================

const errorRate = new Rate('errors');
const p95Latency = new Trend('p95_latency');
const processingRate = new Counter('rows_processed');
const fileUploadSize = new Trend('file_upload_size');

// ============================================================================
// Test Options
// ============================================================================

export const options = {
  scenarios: {
    // Hono HTTP load test
    hono_http_load: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeLimit: CONFIG.testDuration,
      preAllocatedVUs: CONFIG.targetVUs,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 300 },
        { duration: '30s', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 0 },
      ],
      exec: 'honoHttpTest',
      startTime: '0s',
    },

    // Elysia HTTP load test
    elysia_http_load: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeLimit: CONFIG.testDuration,
      preAllocatedVUs: CONFIG.targetVUs,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 300 },
        { duration: '30s', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 0 },
      ],
      exec: 'elysiaHttpTest',
      startTime: '0s',
    },

    // Health check stress test
    health_check_stress: {
      executor: 'constant-arrival-rate',
      rate: 1000,
      timeLimit: '1m',
      preAllocatedVUs: 50,
      exec: 'healthCheckTest',
      startTime: '0s',
    },

    // Soak test - sustained load
    soak_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 100 },
        { duration: '5m', target: 100 },
        { duration: '2m', target: 200 },
        { duration: '5m', target: 200 },
        { duration: '2m', target: 0 },
      ],
      exec: 'soakTest',
      startTime: '0s',
    },

    // Spike test - sudden load increase
    spike_test: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'spikeTest',
      startTime: '0s',
    },
  },

  thresholds: {
    'http_req_duration': [
      'p(95)<2000', // 95% of requests must complete below 2s
      'p(99)<5000', // 99% of requests must complete below 5s
    ],
    'http_req_failed': [
      'rate<0.01', // Error rate must be less than 1%
    ],
    'errors': [
      'rate<0.01', // Custom error rate less than 1%
    ],
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate CSV file content in memory
 */
function generateCSV(rowCount) {
  const regions = ['North America', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East'];
  const countries = ['USA', 'Canada', 'UK', 'Germany', 'France', 'Japan', 'China', 'Brazil', 'Mexico', 'UAE'];
  const categories = ['Electronics', 'Clothing', 'Food', 'Books', 'Toys'];

  let csv = 'id,region,country,amount,date,category\n';

  for (let i = 1; i <= rowCount; i++) {
    const region = regions[Math.floor(Math.random() * regions.length)];
    const country = countries[Math.floor(Math.random() * countries.length)];
    const amount = (Math.random() * 1000 + 10).toFixed(2);
    const date = new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const category = categories[Math.floor(Math.random() * categories.length)];

    csv += `${i},${region},${country},${amount},${date},${category}\n`;
  }

  return csv;
}

/**
 * Get authentication headers
 */
function getAuthHeaders() {
  const headers = {
    'Content-Type': 'multipart/form-data',
  };

  if (CONFIG.jwtToken) {
    headers['Authorization'] = `Bearer ${CONFIG.jwtToken}`;
  }

  if (CONFIG.apiKey) {
    headers['X-API-Key'] = CONFIG.apiKey;
  }

  return headers;
}

/**
 * Upload CSV file and verify response
 */
function uploadCSV(baseUrl, rowCount, authHeaders) {
  const csvContent = generateCSV(rowCount);
  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).substring(2);

  // Build multipart body
  let body = '';
  body += `--${boundary}\r\n`;
  body += 'Content-Disposition: form-data; name="file"; filename="test.csv"\r\n';
  body += 'Content-Type: text/csv\r\n\r\n';
  body += csvContent + '\r\n';
  body += `--${boundary}--\r\n`;

  const params = {
    headers: {
      ...authHeaders,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    timeout: '30s',
  };

  const response = http.post(`${baseUrl}/api/v1/import`, body, params);

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'has response data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true && body.data !== undefined;
      } catch {
        return false;
      }
    },
    'row count matches': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data.rowCount === rowCount;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);

  if (success) {
    try {
      const body = JSON.parse(response.body);
      processingRate.add(body.data.rowCount);
      fileUploadSize.add(csvContent.length);
      p95Latency.add(response.timings.duration);
    } catch (e) {
      // Ignore parsing errors
    }
  }

  return { success, response };
}

/**
 * Health check request
 */
function healthCheck(baseUrl) {
  const response = http.get(`${baseUrl}/health`, {
    tags: { name: 'health_check' },
  });

  const success = check(response, {
    'status is 200 or 503': (r) => r.status === 200 || r.status === 503,
    'has status field': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status !== undefined;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);
  return success;
}

// ============================================================================
// Test Scenarios
// ============================================================================

/**
 * Hono HTTP load test
 */
export function honoHttpTest() {
  const authHeaders = getAuthHeaders();
  const rowCounts = [100, 1000, 10000, 100000];
  const rowCount = rowCounts[Math.floor(Math.random() * rowCounts.length)];

  const { success, response } = uploadCSV(CONFIG.honoBaseUrl, rowCount, authHeaders);

  if (!success) {
    console.error(`Hono request failed: ${response.status} ${response.body.substring(0, 200)}`);
  }

  sleep(Math.random() * 2); // Random think time 0-2s
}

/**
 * Elysia HTTP load test
 */
export function elysiaHttpTest() {
  const authHeaders = getAuthHeaders();
  const rowCounts = [100, 1000, 10000, 100000];
  const rowCount = rowCounts[Math.floor(Math.random() * rowCounts.length)];

  const { success, response } = uploadCSV(CONFIG.elysiaBaseUrl, rowCount, authHeaders);

  if (!success) {
    console.error(`Elysia request failed: ${response.status} ${response.body.substring(0, 200)}`);
  }

  sleep(Math.random() * 2);
}

/**
 * Health check stress test
 */
export function healthCheckTest() {
  healthCheck(CONFIG.honoBaseUrl);
  healthCheck(CONFIG.elysiaBaseUrl);
}

/**
 * Soak test - sustained moderate load
 */
export function soakTest() {
  const authHeaders = getAuthHeaders();

  // Mix of small, medium, and large files
  const scenarios = [
    () => uploadCSV(CONFIG.honoBaseUrl, 100, authHeaders),
    () => uploadCSV(CONFIG.honoBaseUrl, 1000, authHeaders),
    () => healthCheck(CONFIG.honoBaseUrl),
  ];

  const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
  scenario();

  sleep(1);
}

/**
 * Spike test - simulate sudden traffic spike
 */
export function spikeTest() {
  const authHeaders = getAuthHeaders();

  // During spike, send many concurrent requests
  const requests = [];
  for (let i = 0; i < 10; i++) {
    requests.push(() => uploadCSV(CONFIG.honoBaseUrl, 1000, authHeaders));
  }

  // Execute in parallel (k6 handles this)
  const scenario = requests[Math.floor(Math.random() * requests.length)];
  scenario();

  sleep(0.1);
}

// ============================================================================
// Setup and Teardown
// ============================================================================

export function setup() {
  console.log('Starting k6 load test...');
  console.log(`Hono URL: ${CONFIG.honoBaseUrl}`);
  console.log(`Elysia URL: ${CONFIG.elysiaBaseUrl}`);
  console.log(`Duration: ${CONFIG.testDuration}`);
  console.log(`Target VUs: ${CONFIG.targetVUs}`);

  // Verify services are accessible
  const honoHealth = http.get(`${CONFIG.honoBaseUrl}/health`);
  const elysiaHealth = http.get(`${CONFIG.elysiaBaseUrl}/health`);

  if (honoHealth.status > 0) {
    console.log(`Hono service is accessible: ${honoHealth.status}`);
  } else {
    console.error('Hono service is not accessible!');
  }

  if (elysiaHealth.status > 0) {
    console.log(`Elysia service is accessible: ${elysiaHealth.status}`);
  } else {
    console.error('Elysia service is not accessible!');
  }

  return { honoHealth: honoHealth.status, elysiaHealth: elysiaHealth.status };
}

export function teardown(data) {
  console.log('Load test completed');
  console.log(`Final health check - Hono: ${data.honoHealth}, Elysia: ${data.elysiaHealth}`);
}

// ============================================================================
// Summary Report
// ============================================================================

export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data),
    'report.html': htmlReport(data),
  };
}

// Text summary function
function textSummary(data, options) {
  const { indent = '', enableColors = false } = options || {};
  const reset = enableColors ? '\x1b[0m' : '';
  const green = enableColors ? '\x1b[32m' : '';
  const red = enableColors ? '\x1b[31m' : '';
  const yellow = enableColors ? '\x1b[33m' : '';

  let summary = '\n' + '='.repeat(60) + '\n';
  summary += 'Load Test Summary Report\n';
  summary += '='.repeat(60) + '\n\n';

  // HTTP metrics
  const httpReqs = data.metrics.http_reqs;
  const httpDuration = data.metrics.http_req_duration;

  summary += `${yellow}HTTP Requests${reset}\n`;
  summary += `${indent}Total Requests: ${httpReqs.values.count}\n`;
  summary += `${indent}Success Rate: ${((1 - data.metrics.http_req_failed.values.rate) * 100).toFixed(2)}%\n`;
  summary += `${indent}Avg Duration: ${httpDuration.values.avg.toFixed(2)}ms\n`;
  summary += `${indent}P95 Duration: ${httpDuration.values['p(95)']?.toFixed(2) || 'N/A'}ms\n`;
  summary += `${indent}P99 Duration: ${httpDuration.values['p(99)']?.toFixed(2) || 'N/A'}ms\n\n`;

  // Custom metrics
  if (data.metrics.rows_processed) {
    summary += `${yellow}Processing${reset}\n`;
    summary += `${indent}Total Rows Processed: ${data.metrics.rows_processed.values.count}\n`;
    summary += `${indent}Rows/Second: ${(data.metrics.rows_processed.values.count / (data.testRunDuration / 1000)).toFixed(2)}\n\n`;
  }

  // Thresholds
  summary += `${yellow}Thresholds${reset}\n`;
  for (const [key, value] of Object.entries(data.metrics)) {
    if (value.thresholds) {
      for (const [thresholdName, threshold] of Object.entries(value.thresholds)) {
        const status = threshold.ok ? green : red;
        summary += `${indent}${status}${thresholdName}: ${threshold.ok ? 'PASS' : 'FAIL'}${reset}\n`;
      }
    }
  }

  summary += '\n' + '='.repeat(60) + '\n';

  return summary;
}

// HTML report function (simplified)
function htmlReport(data) {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Load Test Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1 { color: #333; }
    table { border-collapse: collapse; width: 100%; margin: 20px 0; }
    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
    th { background-color: #4CAF50; color: white; }
    tr:nth-child(even) { background-color: #f2f2f2; }
    .pass { color: green; font-weight: bold; }
    .fail { color: red; font-weight: bold; }
  </style>
</head>
<body>
  <h1>CSV Service Load Test Report</h1>
  <p>Generated: ${new Date().toISOString()}</p>

  <h2>HTTP Metrics</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total Requests</td><td>${data.metrics.http_reqs?.values.count || 0}</td></tr>
    <tr><td>Avg Duration</td><td>${data.metrics.http_req_duration?.values.avg?.toFixed(2) || 0}ms</td></tr>
    <tr><td>P95 Duration</td><td>${data.metrics.http_req_duration?.values['p(95)']?.toFixed(2) || 0}ms</td></tr>
    <tr><td>P99 Duration</td><td>${data.metrics.http_req_duration?.values['p(99)']?.toFixed(2) || 0}ms</td></tr>
    <tr><td>Success Rate</td><td>${((1 - (data.metrics.http_req_failed?.values.rate || 0)) * 100).toFixed(2)}%</td></tr>
  </table>

  <h2>Processing Metrics</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Rows Processed</td><td>${data.metrics.rows_processed?.values.count || 0}</td></tr>
    <tr><td>Throughput</td><td>${((data.metrics.rows_processed?.values.count || 0) / (data.testRunDuration / 1000)).toFixed(2)} rows/s</td></tr>
  </table>

  <h2>Test Configuration</h2>
  <table>
    <tr><th>Setting</th><th>Value</th></tr>
    <tr><td>Test Duration</td><td>${CONFIG.testDuration}</td></tr>
    <tr><td>Target VUs</td><td>${CONFIG.targetVUs}</td></tr>
    <tr><td>Hono Base URL</td><td>${CONFIG.honoBaseUrl}</td></tr>
    <tr><td>Elysia Base URL</td><td>${CONFIG.elysiaBaseUrl}</td></tr>
  </table>
</body>
</html>
  `.trim();
}
