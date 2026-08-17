import { describe, expect, it } from 'vitest';
import { degrees, PDFDocument } from 'pdf-lib';
import { processWorkerImpl, type NewFormField } from '../../src/core/workers/process.worker';
import { extractFormFieldsToCreate } from '../../src/core/operations';
import type { Annotation } from '../../src/core/store';
import { displayFrame, displayPointToPage } from '../../src/core/rotation';

async function makeBlankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([600, 800]);
  return doc.save();
}

describe('SGN-06: Create Form Fields', () => {
  it('creates text field, checkbox, and radio group on export', async () => {
    const inputBytes = await makeBlankPdf();

    const pages = [
      {
        key: 'p1',
        sourceDocId: 'doc1',
        sourceIndex: 0,
        rotation: 0
      }
    ];
    const sources = { doc1: inputBytes };

    const formFieldsToCreate: NewFormField[] = [
      {
        pageKey: 'p1',
        type: 'text',
        name: 'applicant_name',
        x: 0.1,
        y: 0.1,
        width: 0.4,
        height: 0.05
      },
      {
        pageKey: 'p1',
        type: 'checkbox',
        name: 'terms_agreed',
        x: 0.1,
        y: 0.2,
        width: 0.05,
        height: 0.05
      },
      {
        pageKey: 'p1',
        type: 'radio',
        name: 'membership_type',
        exportValue: 'standard',
        x: 0.1,
        y: 0.3,
        width: 0.05,
        height: 0.05
      },
      {
        pageKey: 'p1',
        type: 'radio',
        name: 'membership_type',
        exportValue: 'premium',
        x: 0.2,
        y: 0.3,
        width: 0.05,
        height: 0.05
      }
    ];

    const composedBytes = await processWorkerImpl.compose(
      pages,
      sources,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { formFieldsToCreate }
    );

    expect(composedBytes).toBeInstanceOf(Uint8Array);
    expect(composedBytes.length).toBeGreaterThan(0);

    // 1. Re-parse created fields via getFormFields
    const formInfo = await processWorkerImpl.getFormFields(composedBytes);
    expect(formInfo.isXfa).toBe(false);
    expect(formInfo.fields).toHaveLength(3);

    const textField = formInfo.fields.find(f => f.name === 'applicant_name');
    expect(textField).toBeDefined();
    expect(textField?.type).toBe('TextField');
    expect(textField?.rects).toHaveLength(1);

    const checkBox = formInfo.fields.find(f => f.name === 'terms_agreed');
    expect(checkBox).toBeDefined();
    expect(checkBox?.type).toBe('CheckBox');
    expect(checkBox?.value).toBe(false);

    const radioGroup = formInfo.fields.find(f => f.name === 'membership_type');
    expect(radioGroup).toBeDefined();
    expect(radioGroup?.type).toBe('RadioGroup');
    expect(radioGroup?.options).toEqual(['standard', 'premium']);
    expect(radioGroup?.rects).toHaveLength(2);

    // 2. Verify filling the newly created form fields back via SGN-03 (fillFormFields)
    const filledBytes = await processWorkerImpl.fillFormFields(
      composedBytes,
      {
        applicant_name: 'John Doe',
        terms_agreed: true,
        membership_type: 'premium'
      },
      false
    );

    const filledFormInfo = await processWorkerImpl.getFormFields(filledBytes);
    const filledTextField = filledFormInfo.fields.find(f => f.name === 'applicant_name');
    expect(filledTextField?.value).toBe('John Doe');

    const filledCheckBox = filledFormInfo.fields.find(f => f.name === 'terms_agreed');
    expect(filledCheckBox?.value).toBe(true);

    const filledRadioGroup = filledFormInfo.fields.find(f => f.name === 'membership_type');
    expect(filledRadioGroup?.value).toBe('premium');
  });

  it('extracts form field creation specifications from annotations array', () => {
    const annotations: Annotation[] = [
      {
        id: '1',
        pageKey: 'p1',
        type: 'form-text',
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.04,
        data: '',
        fieldName: 'email'
      },
      {
        id: '2',
        pageKey: 'p1',
        type: 'form-checkbox',
        x: 0.1,
        y: 0.2,
        width: 0.05,
        height: 0.05,
        data: '',
        fieldName: 'opt_in'
      },
      {
        id: '3',
        pageKey: 'p1',
        type: 'form-radio',
        x: 0.1,
        y: 0.3,
        width: 0.05,
        height: 0.05,
        data: '',
        fieldName: 'plan',
        exportValue: 'monthly'
      }
    ];

    const extracted = extractFormFieldsToCreate(annotations);
    expect(extracted).toHaveLength(3);
    expect(extracted[0]).toEqual({
      pageKey: 'p1',
      type: 'form-text',
      name: 'email',
      exportValue: undefined,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.04
    });
    expect(extracted[1].name).toBe('opt_in');
    expect(extracted[2].exportValue).toBe('monthly');
  });

  it('names a conflicting existing field instead of surfacing a pdf-lib error', async () => {
    const inputBytes = await makeBlankPdf();
    await expect(
      processWorkerImpl.compose(
        [{ key: 'p1', sourceDocId: 'doc1', sourceIndex: 0, rotation: 0 }],
        { doc1: inputBytes },
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          formFieldsToCreate: [
            {
              pageKey: 'p1',
              type: 'text',
              name: 'same-name',
              x: 0.1,
              y: 0.1,
              width: 0.2,
              height: 0.05
            },
            {
              pageKey: 'p1',
              type: 'checkbox',
              name: 'same-name',
              x: 0.1,
              y: 0.2,
              width: 0.05,
              height: 0.05
            }
          ]
        }
      )
    ).rejects.toMatchObject({
      kind: 'UnsupportedFeature',
      message: expect.stringContaining('same-name')
    });
  });

  it('maps new widget rectangles through the displayed crop and rotation frame', async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([600, 800]);
    sourcePage.setRotation(degrees(90));
    sourcePage.setCropBox(100, 200, 300, 400);
    const bytes = await source.save();

    const output = await processWorkerImpl.compose(
      [{ key: 'p1', sourceDocId: 'doc1', sourceIndex: 0, rotation: 0 }],
      { doc1: bytes },
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        formFieldsToCreate: [
          { pageKey: 'p1', type: 'text', name: 'rotated', x: 0.1, y: 0.2, width: 0.3, height: 0.1 }
        ]
      }
    );
    const outputDoc = await PDFDocument.load(output);
    const field = outputDoc.getForm().getTextField('rotated');
    const rect = field.acroField.getWidgets()[0].getRectangle();
    const outputPage = outputDoc.getPage(0);
    const crop = outputPage.getCropBox();
    const frame = displayFrame(
      crop.width,
      crop.height,
      outputPage.getRotation().angle,
      crop.x,
      crop.y
    );
    const a = displayPointToPage(frame, 0.1 * frame.displayWidth, 0.2 * frame.displayHeight);
    const b = displayPointToPage(frame, 0.4 * frame.displayWidth, 0.3 * frame.displayHeight);

    // Map two corners of the 0.1,0.2,0.3,0.1 UI box in display space; taking
    // extents yields the raw-page widget rectangle under /Rotate and CropBox.
    // pdf-lib expands the widget rectangle by its half-point default border.
    expect(Math.abs(rect.x - Math.min(a.x, b.x))).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.y - Math.min(a.y, b.y))).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.width - Math.abs(b.x - a.x))).toBeLessThanOrEqual(1);
    expect(Math.abs(rect.height - Math.abs(b.y - a.y))).toBeLessThanOrEqual(1);
  });
});
