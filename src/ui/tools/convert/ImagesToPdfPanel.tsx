/**
 * Images → PDF options (CNV-01), as a standalone tool.
 *
 * Mirrors `PdfToImagePanel`'s sibling direction: pick images, order them, choose
 * page size/orientation/margin/quality, export. `worksWithoutDocument` lets this
 * run with no PDF open — the action bar's commit builds the PDF from `files`.
 */
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { IMAGES_ONLY } from '../../../platform/index';
import { isSupportedImage } from '../../../core/image';
import { notify } from '../../../core/notify';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import { Field, RadioGroup, Select, NumberStepper } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { imagesToPdfSettings } from '../state';
import { useTranslation } from '../../../core/i18n';

export function ImagesToPdfPanel() {
  const t = useTranslation();
  const settings = imagesToPdfSettings.value;

  const addImages = async () => {
    const opened = await platform.openFiles({ multiple: true, accept: IMAGES_ONLY });
    if (opened.length === 0) return;
    const files = await Promise.all(opened.map(handle => handle.getFile()));
    const images = files.filter(isSupportedImage);
    const rejected = files.length - images.length;
    if (rejected > 0) {
      notify(
        'warning',
        t('{count} file(s) were not images and were skipped.', { count: rejected })
      );
    }
    if (images.length > 0) {
      imagesToPdfSettings.value = { ...settings, files: [...settings.files, ...images] };
    }
  };

  const removeAt = (index: number) => {
    const files = settings.files.filter((_, i) => i !== index);
    imagesToPdfSettings.value = { ...settings, files };
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= settings.files.length) return;
    const files = [...settings.files];
    [files[index], files[target]] = [files[target], files[index]];
    imagesToPdfSettings.value = { ...settings, files };
  };

  return (
    <>
      <Button variant="secondary" icon={Plus} onClick={addImages}>
        {t('Add images')}
      </Button>

      {settings.files.length > 0 && (
        <div className={panelStyles.section}>
          <h2 className={panelStyles.title}>{t('Pages')}</h2>
          <ol className={panelStyles.list}>
            {settings.files.map((file, index) => (
              <li className={panelStyles.listRow} key={`${file.name}-${index}`} title={file.name}>
                <span className={panelStyles.listRowText}>
                  {index + 1}. {file.name}
                </span>
                <IconButton
                  icon={ArrowUp}
                  size="compact"
                  aria-label={t('Move up')}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                />
                <IconButton
                  icon={ArrowDown}
                  size="compact"
                  aria-label={t('Move down')}
                  disabled={index === settings.files.length - 1}
                  onClick={() => move(index, 1)}
                />
                <IconButton
                  icon={X}
                  size="compact"
                  aria-label={t('Remove')}
                  onClick={() => removeAt(index)}
                />
              </li>
            ))}
          </ol>
        </div>
      )}

      <Field label={t('Page size')}>
        {id => (
          <Select
            id={id}
            value={settings.pageSize as string}
            onChange={value =>
              (imagesToPdfSettings.value = {
                ...settings,
                pageSize: value as typeof settings.pageSize
              })
            }
            options={[
              { value: 'original', label: t('Original image size') },
              { value: 'a4', label: t('A4') },
              { value: 'letter', label: t('US Letter') }
            ]}
          />
        )}
      </Field>

      <RadioGroup<'auto' | 'portrait' | 'landscape'>
        legend={t('Orientation')}
        name="imagesToPdfOrientation"
        value={settings.orientation}
        onChange={orientation => (imagesToPdfSettings.value = { ...settings, orientation })}
        options={[
          { value: 'auto', label: t('Auto (match image)') },
          { value: 'portrait', label: t('Portrait') },
          { value: 'landscape', label: t('Landscape') }
        ]}
      />

      <Field label={t('Margin (pt)')}>
        {id => (
          <NumberStepper
            id={id}
            min={0}
            max={200}
            value={settings.margin}
            disabled={settings.pageSize === 'original'}
            onChange={margin => (imagesToPdfSettings.value = { ...settings, margin })}
          />
        )}
      </Field>

      <Field label={t('Quality')}>
        {id => (
          <Select
            id={id}
            value={settings.quality}
            onChange={quality => (imagesToPdfSettings.value = { ...settings, quality })}
            options={[
              { value: 1.0, label: t('100% (Lossless)') },
              { value: 0.9, label: t('90% (High)') },
              { value: 0.75, label: t('75% (Medium)') },
              { value: 0.5, label: t('50% (Low)') }
            ]}
          />
        )}
      </Field>

      <p className={panelStyles.description}>
        {settings.files.length === 0
          ? t('Add photos or images to combine them into one PDF.')
          : t('{count} image(s) → one PDF, in this order.', { count: settings.files.length })}
      </p>
    </>
  );
}
