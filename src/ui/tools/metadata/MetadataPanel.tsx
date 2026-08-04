/**
 * RED-04 — the metadata inspector.
 *
 * Shows what the file reveals *before* and confirms it is gone after. This existed
 * only as a `scrubMetadata` call with no inspector, so the user could not see what
 * was being removed or check that it had been.
 */
import { useState } from 'preact/hooks';
import { ScanSearch } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes } from '../../../core/operations';
import { processWorker } from '../../../core/workers';
import type { MetadataFindings } from '../../../core/workers/process.worker';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/OptionsPanel';
import { useJob } from '../../useJob';
import { Checkbox } from '../../components/Field';
import { scrubSettings, type ExtendedScrubSettings } from './state';

const FLAGS: { key: keyof MetadataFindings; label: string }[] = [
  { key: 'hasXmp', label: 'XMP metadata packet' },
  { key: 'hasEmbeddedJavaScript', label: 'Embedded JavaScript' },
  { key: 'hasOpenAction', label: 'Action on open' },
  { key: 'hasAdditionalActions', label: 'Additional actions' },
  { key: 'hasEmbeddedFiles', label: 'Embedded files' },
  { key: 'hasPageThumbnails', label: 'Embedded page thumbnails' },
  { key: 'hasOptionalContent', label: 'Hidden layers' }
];

const FIELDS: { key: keyof MetadataFindings; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'author', label: 'Author' },
  { key: 'subject', label: 'Subject' },
  { key: 'creator', label: 'Creating application' },
  { key: 'producer', label: 'Producer' },
  { key: 'creationDate', label: 'Created' },
  { key: 'modificationDate', label: 'Modified' },
  { key: 'keywords', label: 'Keywords' }
];

export function MetadataPanel() {
  const doc = activeDoc.value;
  const [findings, setFindings] = useState<MetadataFindings | null>(null);
  const [hasCustomInfo, setHasCustomInfo] = useState<boolean>(false);
  const { run } = useJob();
  if (!doc) return null;

  const inspect = () =>
    run({ label: 'Reading metadata', scope: 'metadata.inspect' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const res = await processWorker.lease(api => api.readMetadata(bytes));
      setFindings(res);

      const newSettings: ExtendedScrubSettings = { customInfo: res.hasCustomInfo };
      setHasCustomInfo(Boolean(res.hasCustomInfo));
      for (const field of [...FIELDS, ...FLAGS]) {
        if (res[field.key]) newSettings[field.key] = true;
      }
      scrubSettings.value = newSettings;
    });

  const present = findings
    ? [
        ...FIELDS.filter(field => Boolean(findings[field.key])).map(field => ({
          key: field.key,
          label: field.label,
          value: String(findings[field.key])
        })),
        ...FLAGS.filter(flag => findings[flag.key] === true).map(flag => ({
          key: flag.key,
          label: flag.label,
          value: 'present'
        }))
      ]
    : [];

  return (
    <>
      <Button variant="secondary" icon={ScanSearch} onClick={inspect}>
        Inspect this document
      </Button>

      {findings && present.length === 0 && !hasCustomInfo && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          Nothing identifying found: no author, no paths, no XMP, no embedded scripts.
        </p>
      )}

      {(present.length > 0 || hasCustomInfo) && (
        <div className={panelStyles.section}>
          <h3 className={panelStyles.title}>Found in this file</h3>
          <ul className={panelStyles.list}>
            {present.map(item => (
              <li className={panelStyles.listRow} key={item.key}>
                <Checkbox
                  label={item.label}
                  checked={scrubSettings.value[item.key] ?? false}
                  onChange={checked =>
                    (scrubSettings.value = {
                      ...scrubSettings.value,
                      [item.key]: checked
                    })
                  }
                />
                <span className={panelStyles.listRowText}>{item.value}</span>
              </li>
            ))}
            {hasCustomInfo && (
              <li className={panelStyles.listRow} key="customInfo">
                <Checkbox
                  label="Custom properties and paths"
                  checked={scrubSettings.value.customInfo ?? false}
                  onChange={checked =>
                    (scrubSettings.value = {
                      ...scrubSettings.value,
                      customInfo: checked
                    })
                  }
                />
                <span className={panelStyles.listRowText}>present</span>
              </li>
            )}
          </ul>
          <p className={panelStyles.description}>
            Selected items will be stripped from the document. The file is rebuilt so the removed
            objects are absent rather than merely unreferenced.
          </p>
        </div>
      )}
    </>
  );
}
