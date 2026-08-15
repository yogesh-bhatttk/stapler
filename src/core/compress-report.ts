/**
 * CMP-06 — Compression report generation and export.
 *
 * Provides an exportable per-page/per-image breakdown (sizes before/after,
 * which images were re-encoded vs skipped and why) as a plain-text or JSON
 * sidecar report.
 */

import type { CompressionPlan, PageRoute } from './compress-plan';

export interface ImageResultStat {
  pageIndex: number;
  imageId: string;
  objectNumber?: number;
  originalBytes?: number;
  compressedBytes?: number;
  status: 're-encoded' | 'skipped';
  skipReason?: string;
}

export interface CompressionResultStats {
  originalBytes: number;
  compressedBytes: number;
  keptOriginal?: boolean;
  imageStats?: ImageResultStat[];
}

export interface CompressionReportData {
  summary: {
    originalBytes: number;
    compressedBytes: number;
    savingsBytes: number;
    savingsPercent: number;
    keptOriginal: boolean;
    skippedConstructs: string[];
  };
  pages: Array<{
    pageIndex: number;
    route: PageRoute;
    reason: string;
    images: Array<{
      imageId: string;
      objectNumber?: number;
      status: 're-encoded' | 'skipped';
      originalBytes?: number;
      compressedBytes?: number;
      skipReason?: string;
    }>;
  }>;
}

/**
 * Builds structured data for the compression report.
 */
export function buildCompressionReportData(
  plan: CompressionPlan,
  resultStats: CompressionResultStats
): CompressionReportData {
  const originalBytes = resultStats.originalBytes;
  const compressedBytes = resultStats.compressedBytes;
  const savingsBytes = Math.max(0, originalBytes - compressedBytes);
  const savingsPercent =
    originalBytes > 0 ? Number(((savingsBytes / originalBytes) * 100).toFixed(2)) : 0;
  const keptOriginal = Boolean(resultStats.keptOriginal);

  const imageStatsByPage = new Map<number, ImageResultStat[]>();
  if (resultStats.imageStats) {
    for (const stat of resultStats.imageStats) {
      const list = imageStatsByPage.get(stat.pageIndex) ?? [];
      list.push(stat);
      imageStatsByPage.set(stat.pageIndex, list);
    }
  }

  const pages = plan.pages.map(page => {
    let images: Array<{
      imageId: string;
      objectNumber?: number;
      status: 're-encoded' | 'skipped';
      originalBytes?: number;
      compressedBytes?: number;
      skipReason?: string;
    }> = [];

    const customStats = imageStatsByPage.get(page.pageIndex);
    if (customStats && customStats.length > 0) {
      images = customStats.map(s => ({
        imageId: s.imageId,
        objectNumber: s.objectNumber,
        status: s.status,
        originalBytes: s.originalBytes,
        compressedBytes: s.compressedBytes,
        skipReason: s.skipReason
      }));
    } else {
      if (page.route === 'surgical') {
        images = page.reencode.map(img => ({
          imageId: img.name,
          objectNumber: img.objectNumber,
          status: 're-encoded' as const
        }));
      } else if (page.route === 'raster') {
        images = [
          {
            imageId: `page-${page.pageIndex + 1}-raster`,
            status: 're-encoded' as const
          }
        ];
      } else if (page.route === 'skip') {
        images = [
          {
            imageId: `page-${page.pageIndex + 1}-skipped`,
            status: 'skipped' as const,
            skipReason: page.reason
          }
        ];
      } else if (page.route === 'already-optimized') {
        images = [
          {
            imageId: `page-${page.pageIndex + 1}-optimized`,
            status: 'skipped' as const,
            skipReason: page.reason
          }
        ];
      }
    }

    return {
      pageIndex: page.pageIndex,
      route: page.route,
      reason: page.reason,
      images
    };
  });

  return {
    summary: {
      originalBytes,
      compressedBytes,
      savingsBytes,
      savingsPercent,
      keptOriginal,
      skippedConstructs: plan.skipped
    },
    pages
  };
}

/**
 * Generates a plain-text compression report detailing total original & final size,
 * skipped constructs, and per-page / per-image breakdown.
 */
export function generateCompressionReportText(
  plan: CompressionPlan,
  resultStats: CompressionResultStats
): string {
  const data = buildCompressionReportData(plan, resultStats);
  const lines: string[] = [];

  lines.push('================================================================================');
  lines.push('STAPLER COMPRESSION REPORT');
  lines.push('================================================================================');
  lines.push('');
  lines.push('SUMMARY');
  lines.push('--------------------------------------------------------------------------------');
  lines.push(`Original Size:   ${data.summary.originalBytes.toLocaleString()} bytes`);
  lines.push(`Compressed Size: ${data.summary.compressedBytes.toLocaleString()} bytes`);
  lines.push(
    `Saved:           ${data.summary.savingsBytes.toLocaleString()} bytes (${data.summary.savingsPercent}%)`
  );
  lines.push(
    `Status:          ${data.summary.keptOriginal ? 'Kept Original File (Output was not smaller)' : 'Compressed'}`
  );
  lines.push('');

  if (data.summary.skippedConstructs.length > 0) {
    lines.push('SKIPPED CONSTRUCTS (CMP-04 Safety Summary)');
    lines.push('--------------------------------------------------------------------------------');
    for (const item of data.summary.skippedConstructs) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  lines.push('PAGE & IMAGE BREAKDOWN');
  lines.push('--------------------------------------------------------------------------------');

  for (const p of data.pages) {
    lines.push(`Page ${p.pageIndex + 1}:`);
    lines.push(`  Route:  ${p.route}`);
    lines.push(`  Reason: ${p.reason}`);

    if (p.images.length > 0) {
      lines.push('  Images:');
      for (const img of p.images) {
        const objStr = img.objectNumber !== undefined ? ` (Object #${img.objectNumber})` : '';
        lines.push(`    - Image ID: ${img.imageId}${objStr}`);
        lines.push(`      Status:   ${img.status}`);
        if (img.originalBytes !== undefined) {
          lines.push(`      Original Size:   ${img.originalBytes.toLocaleString()} bytes`);
        }
        if (img.compressedBytes !== undefined) {
          lines.push(`      Compressed Size: ${img.compressedBytes.toLocaleString()} bytes`);
        }
        if (img.skipReason) {
          lines.push(`      Skip Reason:     ${img.skipReason}`);
        }
      }
    } else {
      lines.push('  Images: None');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generates a JSON format compression report string.
 */
export function generateCompressionReportJson(
  plan: CompressionPlan,
  resultStats: CompressionResultStats
): string {
  const data = buildCompressionReportData(plan, resultStats);
  return JSON.stringify(data, null, 2);
}
