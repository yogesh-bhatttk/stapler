/**
 * RED-04 — the metadata inspector and scrubber.
 *
 * Shows what the file reveals *before* and confirms it is gone after. This existed
 * only as a `scrubMetadata` call with no inspector, so the user could not see what
 * was being removed or check that it had been.
 *
 * Every finding carries its own checkbox (per-item control), and "Select all" /
 * "Select none" keep the one-click strip-all that the tool started with. Filesystem
 * paths get their own section: a `C:\Users\…` string is the disclosure people care
 * about most and it hides in Producer, in a custom Info key, and in the XMP packet at
 * once, so each occurrence is listed with the item whose removal takes it with it.
 */
import { useState } from 'preact/hooks';
import { ScanSearch } from 'lucide-preact';
import { activeDoc } from '../../../core/store';
import { currentDocumentBytes } from '../../../core/operations';
import { processWorker } from '../../../core/workers';
import type { MetadataFindings } from '../../../core/workers/process.worker';
import { Button } from '../../components/Button';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { Checkbox } from '../../components/Field';
import { scrubSettings, type ExtendedScrubSettings } from './state';
import { ProtectSection } from '../protect/ProtectSection';
import { useTranslation } from '../../../core/i18n';

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

/** Every scrub key this document actually offers, so select-all touches only real findings. */
function offeredKeys(findings: MetadataFindings): (keyof ExtendedScrubSettings)[] {
  const keys: (keyof ExtendedScrubSettings)[] = [];
  for (const field of FIELDS) if (findings[field.key]) keys.push(field.key);
  for (const flag of FLAGS) if (findings[flag.key] === true) keys.push(flag.key);
  if (findings.hasCustomInfo) keys.push('customInfo');
  return keys;
}

export function MetadataPanel() {
  const t = useTranslation();
  const doc = activeDoc.value;
  const [findings, setFindings] = useState<MetadataFindings | null>(null);
  const { run } = useJob();
  if (!doc) return null;

  const setAll = (checked: boolean) => {
    if (!findings) return;
    const next: ExtendedScrubSettings = { ...scrubSettings.value };
    for (const key of offeredKeys(findings)) next[key] = checked;
    scrubSettings.value = next;
  };

  const toggle = (key: keyof ExtendedScrubSettings, checked: boolean) => {
    scrubSettings.value = { ...scrubSettings.value, [key]: checked };
  };

  const inspect = () =>
    run({ label: 'Reading metadata', scope: 'metadata.inspect' }, async job => {
      const bytes = await currentDocumentBytes(job);
      const res = await processWorker.lease(api => api.readMetadata(bytes));
      setFindings(res);

      // Everything found starts selected, so "Inspect then export" is still a
      // one-click strip-all; unticking is the per-item opt-out.
      const newSettings: ExtendedScrubSettings = {};
      for (const key of offeredKeys(res)) newSettings[key] = true;
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

  const custom = findings?.customInfo ?? [];
  const paths = findings?.filesystemPaths ?? [];
  const anythingFound = present.length > 0 || custom.length > 0;

  return (
    <>
      <Button variant="secondary" icon={ScanSearch} onClick={inspect}>
        {t('Inspect this document')}
      </Button>

      {findings && !anythingFound && (
        <p className={`${panelStyles.note} ${panelStyles.noteInfo}`}>
          {t('Nothing identifying found: no author, no paths, no XMP, no embedded scripts.')}
        </p>
      )}

      {anythingFound && (
        <div className={panelStyles.section}>
          <h2 className={panelStyles.title}>{t('Found in this file')}</h2>
          <div role="group" aria-label={t('Select what to strip')} className={panelStyles.actions}>
            <Button variant="tertiary" size="compact" onClick={() => setAll(true)}>
              {t('Select all')}
            </Button>
            <Button variant="tertiary" size="compact" onClick={() => setAll(false)}>
              {t('Select none')}
            </Button>
          </div>
          <ul className={panelStyles.list}>
            {present.map(item => (
              <li className={panelStyles.listRow} key={item.key}>
                <Checkbox
                  label={item.label}
                  checked={scrubSettings.value[item.key] ?? false}
                  onChange={checked => toggle(item.key, checked)}
                />
                <span className={panelStyles.listRowText} title={item.value}>
                  {item.value}
                </span>
              </li>
            ))}
            {custom.length > 0 && (
              <li className={panelStyles.listRow} key="customInfo">
                <Checkbox
                  label={t('Custom properties and paths')}
                  checked={scrubSettings.value.customInfo ?? false}
                  onChange={checked => toggle('customInfo', checked)}
                />
                <span
                  className={panelStyles.listRowText}
                  title={custom.map(entry => `${entry.key}: ${entry.value}`).join('\n')}
                >
                  {custom.map(entry => `${entry.key}: ${entry.value}`).join(', ')}
                </span>
              </li>
            )}
          </ul>
          <p className={panelStyles.description}>
            {t(
              'Selected items will be stripped from the document. The file is rebuilt so the removed objects are absent rather than merely unreferenced.'
            )}
          </p>
        </div>
      )}

      {paths.length > 0 && (
        <div className={panelStyles.section}>
          <h2 className={panelStyles.title}>{t('Filesystem paths')}</h2>
          <ul className={panelStyles.list}>
            {paths.map(path => (
              <li className={panelStyles.listRow} key={`${path.source}:${path.value}`}>
                <span className={panelStyles.listRowText} title={path.value}>
                  {path.value}
                </span>
                <span>{path.source}</span>
              </li>
            ))}
          </ul>
          <p className={panelStyles.description}>
            {t('Each path goes when the item it sits in is stripped above.')}
          </p>
        </div>
      )}

      <hr className={panelStyles.divider} />
      <ProtectSection />
    </>
  );
}
