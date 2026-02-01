/**
 * CSV and Excel File Parser
 * Handles parsing, validation, and aggregation
 */

import { readFileSync } from 'fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import type { CsvRow, RegionSummary, AggregatedSummary, ProcessingStats } from '../types.js';

// ============================================================================
// Validation Schema
// ============================================================================

const CSV_ROW_SCHEMA = z.object({
  region: z.string().min(1, 'Region is required'),
  country: z.string().min(1, 'Country is required'),
  amount: z.number().finite('Amount must be a valid number'),
  id: z.string().optional(),
  date: z.string().optional(),
  category: z.string().optional(),
});

// ============================================================================
// CSV Parser
// ============================================================================

interface ParseResult {
  rowCount: number;
  successCount: number;
  errorCount: number;
  summaries: RegionSummary[];
  stats: ProcessingStats;
}

/**
 * Parse CSV buffer
 */
async function parseCSVBuffer(buffer: Buffer): Promise<{ headers: string[]; rows: unknown[] }> {
  const content = buffer.toString('utf-8');

  // Split into lines
  const lines = content.split(/\r?\n/).filter(line => line.trim());

  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  // Extract headers (first line)
  const headers = parseCSVLine(lines[0]);

  // Parse rows
  const rows: unknown[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length > 0) {
      const row: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        row[header.toLowerCase().replace(/[^a-z0-9]/g, '_')] = values[index] || '';
      });
      rows.push(row);
    }
  }

  return { headers, rows };
}

/**
 * Parse a single CSV line handling quoted values
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());

  return result;
}

/**
 * Parse CSV string content using regex (alternative approach)
 */
function parseCSVWithRegex(content: string): { headers: string[]; rows: unknown[] } {
  const lines = content.split(/\r?\n/).filter(line => line.trim());

  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  // Parse CSV using regex for quoted values
  const parseLine = (line: string): string[] => {
    const pattern = /(?:^|,)(?:"([^"]*)"|([^",]*))/g;
    const values: string[] = [];
    let match;

    while ((match = pattern.exec(line)) !== null) {
      values.push(match[1] !== undefined ? match[1] : match[2]);
    }

    return values;
  };

  const headers = parseLine(lines[0]).map(h => h.trim());
  const rows: unknown[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    if (values.some(v => v.trim())) {
      const row: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        const key = header.toLowerCase().replace(/[^a-z0-9]/g, '_');
        let value: string | number = values[index] || '';

        // Try to convert to number for amount fields
        if (key.includes('amount') || key.includes('price') || key.includes('value')) {
          const num = parseFloat(value.replace(/[$,]/g, ''));
          if (!isNaN(num)) value = num;
        }

        row[key] = value;
      });
      rows.push(row);
    }
  }

  return { headers, rows };
}

/**
 * Process CSV file
 */
export async function processCsvFile(buffer: Buffer): Promise<ParseResult> {
  const startTime = Date.now();
  const stats: ProcessingStats = {
    parseDurationMs: 0,
    validateDurationMs: 0,
    aggregateDurationMs: 0,
    totalDurationMs: 0,
  };

  let rows: unknown[] = [];
  let errorCount = 0;

  // Parse
  try {
    const parseStart = Date.now();
    const result = parseCSVWithRegex(buffer.toString('utf-8'));
    rows = result.rows;
    stats.parseDurationMs = Date.now() - parseStart;
  } catch (error) {
    throw new Error(`Failed to parse CSV: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Validate
  const validatedRows: CsvRow[] = [];
  const validationStart = Date.now();

  for (const row of rows) {
    try {
      const validated = CSV_ROW_SCHEMA.parse(row);
      validatedRows.push(validated);
    } catch (error) {
      errorCount++;
      // Log error but continue processing
      if (errorCount <= 10) {
        console.warn('Validation error:', error);
      }
    }
  }

  stats.validateDurationMs = Date.now() - validationStart;

  // Aggregate
  const aggregateStart = Date.now();
  const summaries = aggregateRegionData(validatedRows);
  stats.aggregateDurationMs = Date.now() - aggregateStart;

  stats.totalDurationMs = Date.now() - startTime;

  return {
    rowCount: rows.length,
    successCount: validatedRows.length,
    errorCount,
    summaries,
    stats,
  };
}

/**
 * Process Excel file
 */
export async function processExcelFile(buffer: Buffer): Promise<ParseResult> {
  const startTime = Date.now();
  const stats: ProcessingStats = {
    parseDurationMs: 0,
    validateDurationMs: 0,
    aggregateDurationMs: 0,
    totalDurationMs: 0,
  };

  let rows: unknown[] = [];
  let errorCount = 0;

  // Parse
  try {
    const parseStart = Date.now();
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to JSON
    const rawData = XLSX.utils.sheet_toJSON(worksheet, {
      raw: false,
      defval: '',
    });

    // Normalize keys
    rows = rawData.map((row: any) => {
      const normalized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '_');
        normalized[normalizedKey] = value;
      }
      return normalized;
    });

    stats.parseDurationMs = Date.now() - parseStart;
  } catch (error) {
    throw new Error(`Failed to parse Excel file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Validate
  const validatedRows: CsvRow[] = [];
  const validationStart = Date.now();

  for (const row of rows) {
    try {
      const validated = CSV_ROW_SCHEMA.parse(row);
      validatedRows.push(validated);
    } catch (error) {
      errorCount++;
      if (errorCount <= 10) {
        console.warn('Validation error:', error);
      }
    }
  }

  stats.validateDurationMs = Date.now() - validationStart;

  // Aggregate
  const aggregateStart = Date.now();
  const summaries = aggregateRegionData(validatedRows);
  stats.aggregateDurationMs = Date.now() - aggregateStart;

  stats.totalDurationMs = Date.now() - startTime;

  return {
    rowCount: rows.length,
    successCount: validatedRows.length,
    errorCount,
    summaries,
    stats,
  };
}

// ============================================================================
// Aggregation Functions
// ============================================================================

/**
 * Aggregate data by region and country
 */
function aggregateRegionData(rows: CsvRow[]): RegionSummary[] {
  const aggregation = new Map<string, {
    region: string;
    country: string;
    count: number;
    amountSum: number;
  }>();

  for (const row of rows) {
    const key = `${row.region}:${row.country}`;
    const existing = aggregation.get(key);

    if (existing) {
      existing.count++;
      existing.amountSum += row.amount;
    } else {
      aggregation.set(key, {
        region: row.region,
        country: row.country,
        count: 1,
        amountSum: row.amount,
      });
    }
  }

  // Convert to summaries with averages
  const summaries: RegionSummary[] = [];
  for (const [_, data] of aggregation) {
    summaries.push({
      region: data.region,
      country: data.country,
      count: data.count,
      amountSum: Math.round(data.amountSum * 100) / 100,
      amountAvg: Math.round((data.amountSum / data.count) * 100) / 100,
    });
  }

  // Sort by region name
  summaries.sort((a, b) => a.region.localeCompare(b.region));

  return summaries;
}

/**
 * Aggregate by single field
 */
export function aggregateByField(rows: unknown[], field: string): Map<string, number> {
  const aggregation = new Map<string, number>();

  for (const row of rows) {
    const value = (row as any)[field];
    if (value) {
      const count = aggregation.get(value) || 0;
      aggregation.set(value, count + 1);
    }
  }

  return aggregation;
}

/**
 * Calculate statistics for numeric field
 */
export function calculateNumericStats(rows: unknown[], field: string): {
  min: number;
  max: number;
  sum: number;
  avg: number;
  count: number;
} {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;

  for (const row of rows) {
    const value = (row as any)[field];
    if (typeof value === 'number' && !isNaN(value)) {
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
      count++;
    }
  }

  return {
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    sum: Math.round(sum * 100) / 100,
    avg: count > 0 ? Math.round((sum / count) * 100) / 100 : 0,
    count,
  };
}

/**
 * Group by field and calculate sub-aggregations
 */
export function groupAndAggregate(
  rows: unknown[],
  groupField: string,
  aggField: string
): Map<string, { count: number; sum: number; avg: number }> {
  const groups = new Map<string, { count: number; sum: number }>();

  for (const row of rows) {
    const groupKey = String((row as any)[groupField] || 'unknown');
    const aggValue = (row as any)[aggField];

    if (typeof aggValue === 'number' && !isNaN(aggValue)) {
      const existing = groups.get(groupKey);
      if (existing) {
        existing.count++;
        existing.sum += aggValue;
      } else {
        groups.set(groupKey, { count: 1, sum: aggValue });
      }
    }
  }

  // Calculate averages
  const result = new Map<string, { count: number; sum: number; avg: number }>();
  for (const [key, data] of groups) {
    result.set(key, {
      count: data.count,
      sum: Math.round(data.sum * 100) / 100,
      avg: Math.round((data.sum / data.count) * 100) / 100,
    });
  }

  return result;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Detect file type from buffer
 */
export function detectFileType(buffer: Buffer): 'csv' | 'xlsx' | 'unknown' {
  const header = buffer.slice(0, 8).toString('hex');

  // Excel magic numbers
  if (header === '504b0304' || header === 'd0cf11e0a1b11ae1') {
    return 'xlsx';
  }

  // Try to detect CSV by content
  const content = buffer.toString('utf-8', 0, Math.min(1000, buffer.length));
  if (content.includes(',') && content.includes('\n')) {
    return 'csv';
  }

  return 'unknown';
}

/**
 * Validate file size
 */
export function validateFileSize(buffer: Buffer, maxSize: number = 100 * 1024 * 1024): boolean {
  return buffer.length <= maxSize;
}

/**
 * Generate sample data for testing
 */
export function generateSampleCsv(rows: number = 100): string {
  const regions = ['North America', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East'];
  const countries = ['USA', 'Canada', 'UK', 'Germany', 'France', 'Japan', 'China', 'Brazil', 'Mexico', 'UAE'];
  const categories = ['Electronics', 'Clothing', 'Food', 'Books', 'Toys'];

  let csv = 'id,region,country,amount,date,category\n';

  for (let i = 1; i <= rows; i++) {
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
 * Parse CSV from string
 */
export function parseCsvString(content: string): { headers: string[]; rows: unknown[] } {
  return parseCSVWithRegex(content);
}

export type { ParseResult };
