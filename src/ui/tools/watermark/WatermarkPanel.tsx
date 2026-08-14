import {
  batesSettings,
  watermarkSettings,
  headerFooterSettings,
  readWatermarkImage,
  type WatermarkPosition,
  type HeaderFooterAlign
} from './state';
import { batesLabel, MAX_BATES_DIGITS } from '../../../core/bates';
import { Checkbox } from '../../components/Field';
import { Field, SegmentedControl } from '../../components/Field';
import { Button } from '../../components/Button';
import { notifyError } from '../../../core/notify';
import styles from './WatermarkPanel.module.css';
import { useTranslation } from '../../../core/i18n';

const POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: 'top-left', label: 'Top Left' },
  { value: 'top-center', label: 'Top Center' },
  { value: 'top-right', label: 'Top Right' },
  { value: 'center-left', label: 'Center Left' },
  { value: 'center', label: 'Center' },
  { value: 'center-right', label: 'Center Right' },
  { value: 'bottom-left', label: 'Bottom Left' },
  { value: 'bottom-center', label: 'Bottom Center' },
  { value: 'bottom-right', label: 'Bottom Right' }
];

const ALIGN_OPTIONS: { value: HeaderFooterAlign; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' }
];

export function WatermarkPanel() {
  const t = useTranslation();
  const settings = watermarkSettings.value;
  const headerFooter = headerFooterSettings.value;
  const bates = batesSettings.value;

  const updateBates = (updates: Partial<typeof bates>) => {
    batesSettings.value = { ...bates, ...updates };
  };

  const update = (updates: Partial<typeof settings>) => {
    watermarkSettings.value = { ...settings, ...updates };
  };

  const updateHeaderFooter = (updates: Partial<typeof headerFooter>) => {
    headerFooterSettings.value = { ...headerFooter, ...updates };
  };

  const onPickImage = async (file: File | null) => {
    if (!file) return;
    try {
      const image = await readWatermarkImage(file);
      update({ image });
    } catch (err) {
      notifyError('watermark.image', err);
    }
  };

  return (
    <div className={styles.panel}>
      <SegmentedControl
        legend={t('Watermark type')}
        name="watermark-kind"
        value={settings.kind}
        options={[
          { value: 'text', label: 'Text' },
          { value: 'image', label: 'Image' }
        ]}
        onChange={kind => update({ kind })}
      />

      {settings.kind === 'text' ? (
        <Field label={t('Text')}>
          {id => (
            <>
              <input
                id={id}
                type="text"
                value={settings.text}
                onInput={e => update({ text: e.currentTarget.value })}
                placeholder={t('CONFIDENTIAL or Page {n}')}
                className={styles.input}
              />
              <div className={styles.hint}>
                {t('Use')} {'{n}'} {t('for page number,')} {'{total}'} {t('for total pages.')}
              </div>
            </>
          )}
        </Field>
      ) : (
        <Field label={t('Image')} hint={t('PNG or JPEG, picked from disk.')}>
          {id => (
            <>
              <input
                id={id}
                type="file"
                accept="image/png,image/jpeg"
                aria-label="Watermark image file"
                className={styles.input}
                onChange={e => {
                  const file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
                  void onPickImage(file);
                  e.currentTarget.value = '';
                }}
              />
              {settings.image && (
                <div className={styles.imagePreviewRow}>
                  <span className={styles.hint}>
                    {settings.image.name} ({settings.image.width}×{settings.image.height})
                  </span>
                  <Button size="compact" variant="ghost" onClick={() => update({ image: null })}>
                    {t('Remove')}
                  </Button>
                </div>
              )}
            </>
          )}
        </Field>
      )}

      {settings.kind === 'image' && (
        <Field label={`Size (${Math.round(settings.imageScale * 100)}% of page width)`}>
          {id => (
            <input
              id={id}
              type="range"
              min="0.05"
              max="0.9"
              step="0.05"
              value={settings.imageScale}
              onInput={e => update({ imageScale: parseFloat(e.currentTarget.value) })}
              className={styles.slider}
            />
          )}
        </Field>
      )}

      <Field label={t('Position')}>
        {id => (
          <select
            id={id}
            value={settings.position}
            onChange={e => update({ position: e.currentTarget.value as WatermarkPosition })}
            className={styles.select}
          >
            {POSITIONS.map(p => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label={t('Pages')} hint={t('All pages, or a list such as 1-3, 6.')}>
        {id => (
          <input
            id={id}
            type="text"
            value={settings.pageRange}
            onInput={e => update({ pageRange: e.currentTarget.value })}
            placeholder={t('all')}
            className={styles.input}
          />
        )}
      </Field>

      {settings.kind === 'text' && (
        <Field label={t('Start page number')}>
          {id => (
            <input
              id={id}
              type="number"
              min="1"
              step="1"
              value={settings.startAt}
              onInput={e => update({ startAt: Math.max(1, Number(e.currentTarget.value) || 1) })}
              className={styles.input}
            />
          )}
        </Field>
      )}

      <Field label={`Opacity (${Math.round(settings.opacity * 100)}%)`}>
        {id => (
          <input
            id={id}
            type="range"
            min="0.1"
            max="1"
            step="0.05"
            value={settings.opacity}
            onInput={e => update({ opacity: parseFloat(e.currentTarget.value) })}
            className={styles.slider}
          />
        )}
      </Field>

      <Field label={`Rotation (${settings.rotation}°)`}>
        {id => (
          <input
            id={id}
            type="range"
            min="-90"
            max="90"
            step="15"
            value={settings.rotation}
            onInput={e => update({ rotation: parseFloat(e.currentTarget.value) })}
            className={styles.slider}
          />
        )}
      </Field>

      {settings.kind === 'text' && (
        <>
          <Field label={`Font Size (${settings.fontSize}px)`}>
            {id => (
              <input
                id={id}
                type="range"
                min="12"
                max="144"
                step="2"
                value={settings.fontSize}
                onInput={e => update({ fontSize: parseFloat(e.currentTarget.value) })}
                className={styles.slider}
              />
            )}
          </Field>

          <Field label={t('Color')}>
            {id => (
              <input
                id={id}
                type="color"
                value={settings.color}
                onInput={e => update({ color: e.currentTarget.value })}
                className={styles.colorPicker}
              />
            )}
          </Field>
        </>
      )}

      <div className={styles.sectionDivider} />
      <h3 className={styles.sectionHeading}>{t('Bates numbering')}</h3>
      <p className={styles.hint}>
        {t(
          'Sequential legal numbering, stamped on every exported page and continuous across a split. Independent of the page numbers above.'
        )}
      </p>

      <Checkbox
        label={t('Stamp a Bates number')}
        checked={bates.enabled}
        onChange={enabled => updateBates({ enabled })}
      />

      {bates.enabled && (
        <>
          <Field label={t('Prefix')}>
            {id => (
              <input
                id={id}
                type="text"
                value={bates.prefix}
                onInput={e => updateBates({ prefix: e.currentTarget.value })}
                placeholder={t('ACME-')}
                className={styles.input}
              />
            )}
          </Field>

          <Field label={t('Digits')}>
            {id => (
              <input
                id={id}
                type="number"
                min="1"
                max={MAX_BATES_DIGITS}
                step="1"
                value={bates.digits}
                onInput={e =>
                  updateBates({
                    digits: Math.min(
                      MAX_BATES_DIGITS,
                      Math.max(1, Number(e.currentTarget.value) || 1)
                    )
                  })
                }
                className={styles.input}
              />
            )}
          </Field>

          <Field label={t('Start at')}>
            {id => (
              <input
                id={id}
                type="number"
                min="0"
                step="1"
                value={bates.start}
                onInput={e =>
                  updateBates({ start: Math.max(0, Number(e.currentTarget.value) || 0) })
                }
                className={styles.input}
              />
            )}
          </Field>

          <Field label={t('Bates position')}>
            {id => (
              <select
                id={id}
                value={bates.position}
                onChange={e =>
                  updateBates({ position: e.currentTarget.value as WatermarkPosition })
                }
                className={styles.select}
              >
                {POSITIONS.map(p => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <p className={styles.hint}>
            {t('First page')}: {batesLabel(bates, 0)}
          </p>
        </>
      )}

      <div className={styles.sectionDivider} />
      <h3 className={styles.sectionHeading}>{t('Header & footer')}</h3>
      <p className={styles.hint}>
        {t(
          'A fixed, unrotated line printed in the page margin — distinct from the watermark stamp above. Use'
        )}
        {'{n}'} {t('for page number,')}
        {'{total}'} {t('for total pages.')}
      </p>

      <Field label={t('Header text')}>
        {id => (
          <input
            id={id}
            type="text"
            value={headerFooter.headerText}
            onInput={e => updateHeaderFooter({ headerText: e.currentTarget.value })}
            placeholder={t('Company confidential')}
            className={styles.input}
          />
        )}
      </Field>

      {headerFooter.headerText && (
        <SegmentedControl
          legend={t('Header alignment')}
          name="header-align"
          value={headerFooter.headerAlign}
          options={ALIGN_OPTIONS}
          onChange={headerAlign => updateHeaderFooter({ headerAlign })}
        />
      )}

      <Field label={t('Footer text')}>
        {id => (
          <input
            id={id}
            type="text"
            value={headerFooter.footerText}
            onInput={e => updateHeaderFooter({ footerText: e.currentTarget.value })}
            placeholder={t('Page {n} of {total}')}
            className={styles.input}
          />
        )}
      </Field>

      {headerFooter.footerText && (
        <SegmentedControl
          legend={t('Footer alignment')}
          name="footer-align"
          value={headerFooter.footerAlign}
          options={ALIGN_OPTIONS}
          onChange={footerAlign => updateHeaderFooter({ footerAlign })}
        />
      )}

      {(headerFooter.headerText || headerFooter.footerText) && (
        <Field label={t('Header/footer pages')} hint={t('All pages, or a list such as 1-3, 6.')}>
          {id => (
            <input
              id={id}
              type="text"
              value={headerFooter.pageRange}
              onInput={e => updateHeaderFooter({ pageRange: e.currentTarget.value })}
              placeholder={t('all')}
              className={styles.input}
            />
          )}
        </Field>
      )}
    </div>
  );
}
