import { describe, expect, it } from 'vitest';
import type { CompressionPlan } from '../../src/core/compress-plan';
import {
  buildCompressionReportData,
  generateCompressionReportJson,
  generateCompressionReportText,
  type CompressionResultStats
} from '../../src/core/compress-report';

describe('CMP-06 — Compression report export', () => {
  const samplePlan: CompressionPlan = {
    actionableBytes: 500000,
    skipped: [
      'JPXDecode image (decoder output cannot be re-encoded safely)',
      'DeviceN image (re-encoding would flatten a named ink to RGB)'
    ],
    pages: [
      {
        pageIndex: 0,
        route: 'surgical',
        reason: 'Has text — 2 over-sampled image(s) re-encoded, text left untouched',
        reencode: [
          { name: 'Im1', objectNumber: 12 },
          { name: 'Im2', objectNumber: 15 }
        ],
        actionableBytes: 300000,
        targetPixels: 500000,
        imagePixels: 800000
      },
      {
        pageIndex: 1,
        route: 'raster',
        reason: 'Scanned page — no extractable text, so the page is re-rendered as one image',
        reencode: [],
        actionableBytes: 200000,
        targetPixels: 400000,
        imagePixels: 400000
      },
      {
        pageIndex: 2,
        route: 'skip',
        reason: 'Left untouched — 1 image(s) use constructs Stapler will not re-encode',
        reencode: [],
        actionableBytes: 0,
        targetPixels: 0,
        imagePixels: 300000
      },
      {
        pageIndex: 3,
        route: 'already-optimized',
        reason: 'Text and vectors only, or images already at the target resolution',
        reencode: [],
        actionableBytes: 0,
        targetPixels: 0,
        imagePixels: 0
      }
    ]
  };

  const sampleStats: CompressionResultStats = {
    originalBytes: 1000000,
    compressedBytes: 400000,
    keptOriginal: false,
    imageStats: [
      {
        pageIndex: 0,
        imageId: 'Im1',
        objectNumber: 12,
        originalBytes: 200000,
        compressedBytes: 80000,
        status: 're-encoded'
      },
      {
        pageIndex: 0,
        imageId: 'Im2',
        objectNumber: 15,
        originalBytes: 100000,
        compressedBytes: 40000,
        status: 're-encoded'
      },
      {
        pageIndex: 2,
        imageId: 'Im3',
        objectNumber: 20,
        originalBytes: 150000,
        status: 'skipped',
        skipReason: 'DeviceN image (re-encoding would flatten a named ink to RGB)'
      }
    ]
  };

  it('buildCompressionReportData correctly aggregates plan and result stats', () => {
    const data = buildCompressionReportData(samplePlan, sampleStats);

    expect(data.summary.originalBytes).toBe(1000000);
    expect(data.summary.compressedBytes).toBe(400000);
    expect(data.summary.savingsBytes).toBe(600000);
    expect(data.summary.savingsPercent).toBe(60.0);
    expect(data.summary.keptOriginal).toBe(false);
    expect(data.summary.skippedConstructs).toEqual(samplePlan.skipped);

    expect(data.pages).toHaveLength(4);
    expect(data.pages[0].pageIndex).toBe(0);
    expect(data.pages[0].route).toBe('surgical');
    expect(data.pages[0].images).toHaveLength(2);
    expect(data.pages[0].images[0].imageId).toBe('Im1');
    expect(data.pages[0].images[0].status).toBe('re-encoded');

    expect(data.pages[2].route).toBe('skip');
    expect(data.pages[2].images[0].status).toBe('skipped');
    expect(data.pages[2].images[0].skipReason).toContain('DeviceN image');
  });

  it('generateCompressionReportText generates formatted report containing totals and skip reasons', () => {
    const text = generateCompressionReportText(samplePlan, sampleStats);

    expect(text).toContain('STAPLER COMPRESSION REPORT');
    expect(text).toContain('Original Size:   1,000,000 bytes');
    expect(text).toContain('Compressed Size: 400,000 bytes');
    expect(text).toContain('Saved:           600,000 bytes (60%)');
    expect(text).toContain('JPXDecode image (decoder output cannot be re-encoded safely)');
    expect(text).toContain('DeviceN image (re-encoding would flatten a named ink to RGB)');
    expect(text).toContain('Page 1:');
    expect(text).toContain('Route:  surgical');
    expect(text).toContain('Image ID: Im1 (Object #12)');
    expect(text).toContain('Status:   re-encoded');
    expect(text).toContain('Page 3:');
    expect(text).toContain('Route:  skip');
    expect(text).toContain('Status:   skipped');
  });

  it('generateCompressionReportJson exports valid JSON matching report data', () => {
    const jsonStr = generateCompressionReportJson(samplePlan, sampleStats);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.summary.originalBytes).toBe(1000000);
    expect(parsed.summary.compressedBytes).toBe(400000);
    expect(parsed.summary.savingsBytes).toBe(600000);
    expect(parsed.summary.savingsPercent).toBe(60);
    expect(parsed.summary.skippedConstructs).toEqual(samplePlan.skipped);
    expect(parsed.pages).toHaveLength(4);
  });

  it('handles report generation when no custom imageStats are provided', () => {
    const statsNoImages: CompressionResultStats = {
      originalBytes: 800000,
      compressedBytes: 500000,
      keptOriginal: false
    };

    const text = generateCompressionReportText(samplePlan, statsNoImages);
    expect(text).toContain('Original Size:   800,000 bytes');
    expect(text).toContain('Compressed Size: 500,000 bytes');
    expect(text).toContain('Page 1:');
    expect(text).toContain('Image ID: Im1 (Object #12)');
    expect(text).toContain('Page 2:');
    expect(text).toContain('Image ID: page-2-raster');
    expect(text).toContain('Page 3:');
    expect(text).toContain('Image ID: page-3-skipped');
  });

  it('handles report when output is not smaller and original file is kept', () => {
    const statsKept: CompressionResultStats = {
      originalBytes: 500000,
      compressedBytes: 500000,
      keptOriginal: true
    };

    const text = generateCompressionReportText(samplePlan, statsKept);
    expect(text).toContain('Status:          Kept Original File (Output was not smaller)');
  });

  /*
   * The panel can export a report before anything has been compressed. It used to
   * print the pre-flight projection under the same "Compressed Size:" / "Saved:"
   * labels a finished run gets, which reads as a measurement of work that never
   * happened.
   */
  describe('an estimate is never printed as a measurement', () => {
    const estimate: CompressionResultStats = {
      originalBytes: 1_000_000,
      compressedBytes: 700_000,
      estimated: true
    };

    it('labels projected sizes as estimates and says no run has happened', () => {
      const text = generateCompressionReportText(samplePlan, estimate);
      expect(text).toContain('Estimated Size:  700,000 bytes');
      expect(text).toContain('Estimated Saved: 300,000 bytes (30%)');
      expect(text).toContain('Status:          Estimate only');
      // The measured labels must not appear anywhere in the summary.
      expect(text).not.toContain('Compressed Size: 700,000');
      expect(text).not.toContain('Saved:           300,000');
      expect(text).toContain('nothing has been re-encoded yet');
    });

    it('flags the estimate in the JSON sidecar too', () => {
      const parsed = JSON.parse(generateCompressionReportJson(samplePlan, estimate));
      expect(parsed.summary.estimated).toBe(true);
      const measured = JSON.parse(
        generateCompressionReportJson(samplePlan, { ...estimate, estimated: false })
      );
      expect(measured.summary.estimated).toBe(false);
    });

    it('uses the measured labels once a run has produced bytes', () => {
      const text = generateCompressionReportText(samplePlan, {
        originalBytes: 1_000_000,
        compressedBytes: 700_000,
        keptOriginal: false
      });
      expect(text).toContain('Compressed Size: 700,000 bytes');
      expect(text).toContain('Saved:           300,000 bytes (30%)');
      expect(text).not.toContain('Estimated Size:');
    });
  });

  /*
   * CMP-06's per-image breakdown, as `rebuildCompressed` now measures it: real
   * before/after byte lengths per image, including the ones it refused.
   */
  it('prints measured per-image sizes when the rebuild supplied them', () => {
    const text = generateCompressionReportText(samplePlan, {
      originalBytes: 1_000_000,
      compressedBytes: 620_000,
      keptOriginal: false,
      imageStats: [
        {
          pageIndex: 0,
          imageId: 'Im1',
          objectNumber: 12,
          originalBytes: 400_000,
          compressedBytes: 40_000,
          status: 're-encoded'
        },
        {
          pageIndex: 0,
          imageId: 'Im2',
          objectNumber: 15,
          originalBytes: 8_000,
          compressedBytes: 12_000,
          status: 'skipped',
          skipReason: 'Re-encoding produced 12000 bytes against the original 8000.'
        }
      ]
    });

    expect(text).toContain('Image ID: Im1 (Object #12)');
    expect(text).toContain('Original Size:   400,000 bytes');
    expect(text).toContain('Compressed Size: 40,000 bytes');
    expect(text).toContain('Image ID: Im2 (Object #15)');
    expect(text).toContain('Skip Reason:     Re-encoding produced 12000 bytes');
  });
});
