/**
 * Prometheus Metrics Exporter for Elysia
 */

export function getPrometheusMetrics() {
  const metrics: string[] = [];
  const now = Date.now();
  
  metrics.push('# HELP csv_service_info Service information');
  metrics.push('# TYPE csv_service_info gauge');
  metrics.push(`csv_service_info{service="csv-service-elysia",version="1.0.0"} 1 ${now}`);
  
  metrics.push('# HELP csv_http_requests_total Total HTTP requests');
  metrics.push('# TYPE csv_http_requests_total counter');
  metrics.push('csv_http_requests_total{method="POST",endpoint="/api/v1/import"} 0');
  
  metrics.push('# HELP csv_active_requests Current active requests');
  metrics.push('# TYPE csv_active_requests gauge');
  metrics.push('csv_active_requests 0');
  
  const mem = process.memoryUsage();
  metrics.push('# HELP csv_memory_bytes Memory usage in bytes');
  metrics.push('# TYPE csv_memory_bytes gauge');
  metrics.push(`csv_memory_bytes{type="heap_used",service="elysia"} ${mem.heapUsed}`);
  metrics.push(`csv_memory_bytes{type="heap_total",service="elysia"} ${mem.heapTotal}`);
  metrics.push(`csv_memory_bytes{type="rss",service="elysia"} ${mem.rss}`);
  
  const cpuUsage = process.cpuUsage();
  metrics.push('# HELP csv_cpu_usage_total CPU usage in nanoseconds');
  metrics.push('# TYPE csv_cpu_usage_total counter');
  metrics.push(`csv_cpu_usage_total{type="user",service="elysia"} ${cpuUsage.user}`);
  metrics.push(`csv_cpu_usage_total{type="system",service="elysia"} ${cpuUsage.system}`);
  
  metrics.push(`csv_process_uptime_seconds{service="elysia"} ${process.uptime()}`);
  
  return metrics.join('\n') + '\n';
}
