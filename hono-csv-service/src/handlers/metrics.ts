/**
 * Prometheus Metrics Exporter
 * Exports metrics in Prometheus text format
 */

export function handleMetrics() {
  const metrics = [];
  const now = Date.now();
  
  // Service info
  metrics.push('# HELP csv_service_info Service information');
  metrics.push('# TYPE csv_service_info gauge');
  metrics.push(`csv_service_info{service="csv-service-hono",version="1.0.0"} 1 ${now}`);
  
  // HTTP request counter
  metrics.push('# HELP csv_http_requests_total Total HTTP requests');
  metrics.push('# TYPE csv_http_requests_total counter');
  metrics.push('csv_http_requests_total{method="POST",endpoint="/api/v1/import"} 0');
  
  // Active requests
  metrics.push('# HELP csv_active_requests Current active requests');
  metrics.push('# TYPE csv_active_requests gauge');
  metrics.push('csv_active_requests 0');
  
  // Response times
  metrics.push('# HELP csv_request_duration_ms Request duration in milliseconds');
  metrics.push('# TYPE csv_request_duration_ms histogram');
  metrics.push('csv_request_duration_ms_bucket{le="10"} 0');
  metrics.push('csv_request_duration_ms_bucket{le="50"} 0');
  metrics.push('csv_request_duration_ms_bucket{le="100"} 0');
  metrics.push('csv_request_duration_ms_bucket{le="500"} 0');
  metrics.push('csv_request_duration_ms_bucket{le="1000"} 0');
  metrics.push('csv_request_duration_ms_bucket{le="+Inf"} 0');
  metrics.push('csv_request_duration_ms_sum 0');
  metrics.push('csv_request_duration_ms_count 0');
  
  // Memory usage (from process.memoryUsage())
  const mem = process.memoryUsage();
  metrics.push('# HELP csv_memory_bytes Memory usage in bytes');
  metrics.push('# TYPE csv_memory_bytes gauge');
  metrics.push(`csv_memory_bytes{type="heap_used"} ${mem.heapUsed}`);
  metrics.push(`csv_memory_bytes{type="heap_total"} ${mem.heapTotal}`);
  metrics.push(`csv_memory_bytes{type="rss"} ${mem.rss}`);
  metrics.push(`csv_memory_bytes{type="external"} ${mem.external}`);
  
  // CPU (approximate from process.cpuUsage())
  const cpuUsage = process.cpuUsage();
  metrics.push('# HELP csv_cpu_usage_total CPU usage in nanoseconds');
  metrics.push('# TYPE csv_cpu_usage_total counter');
  metrics.push(`csv_cpu_usage_total{type="user"} ${cpuUsage.user}`);
  metrics.push(`csv_cpu_usage_total{type="system"} ${cpuUsage.system}`);
  
  // Uptime
  metrics.push('# HELP csv_process_uptime_seconds Process uptime in seconds');
  metrics.push('# TYPE csv_process_uptime_seconds gauge');
  metrics.push(`csv_process_uptime_seconds ${process.uptime()}`);
  
  return metrics.join('\n') + '\n';
}
