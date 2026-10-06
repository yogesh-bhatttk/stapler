import { useState } from 'preact/hooks';
import { Search, FileText } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { exportAnnotationSummary, type SummaryAnnotation } from '../../../core/annotation-summary';
import { pageAnnotations } from './state';
import { tKey, translate, useTranslation } from '../../../core/i18n';
import { ANNOTATION_COLORS } from '../../../core/doc-colors';
import { notify } from '../../../core/notify';
import { activeDoc, type StaplerDoc } from '../../../core/store';
import { Button } from '../../components/Button';
import { Checkbox, Field, RadioGroup, Slider, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/panelStyles';
import { useJob } from '../../useJob';
import { FlattenOption } from '../FlattenOption';
import { searchAndHighlightMatches } from './search';
import {
  activeAnnotationTool,
  annotationColor,
  annotationStrokeWidth,
  AnnotationType
} from './state';

const COLOR_NAME_KEYS: Record<string, string> = {
  [ANNOTATION_COLORS[0]]: tKey('tool.annotate.colorYellow'),
  [ANNOTATION_COLORS[1]]: tKey('tool.annotate.colorRed'),
  [ANNOTATION_COLORS[2]]: tKey('tool.annotate.colorGreen'),
  [ANNOTATION_COLORS[3]]: tKey('tool.annotate.colorBlue'),
  [ANNOTATION_COLORS[4]]: tKey('tool.annotate.colorBlack'),
  [ANNOTATION_COLORS[5]]: tKey('tool.annotate.colorWhite')
};

export function AnnotatePanel() {
  const t = useTranslation();
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const { run } = useJob();
  const doc = activeDoc.value;

  /**
   * ANN-04 — a printable summary of every note in the active document.
   * HRD-24 §12.11: through `useJob`, like every other export, so it shows
   * determinate progress and can be cancelled; errors go through
   * `notifyError` with this scope.
   */
  const handleExportSummary = () => {
    const current = activeDoc.value;
    if (!current) return;
    const combined = summaryAnnotationsFor(current);
    if (combined.length === 0) {
      notify('warning', translate('No annotations to export.'));
      return;
    }
    return run(
      { label: translate('Exporting annotation summary'), scope: 'annotate.summary' },
      async job => {
        const summaryBytes = await exportAnnotationSummary(current, combined, job);
        const fileStem = current.name.replace(/\.[^.]+$/, '') || 'document';
        const saved = await platform.saveFileAs(summaryBytes, `${fileStem}-annotation-summary.pdf`);
        if (saved) {
          notify('success', translate('Exported annotation summary PDF.'));
        }
      }
    );
  };

  /**
   * ANN-03 — every match becomes a highlight on ANN-01's layer.
   *
   * The search itself is `findTextRegions`, the same worker call RED's
   * find-and-mark uses; only what is built from the result differs. The helper
   * keeps the search one undo step and drops stale results if the active
   * document changes before the worker returns.
   */
  const highlightMatches = () =>
    run(
      {
        label: translate('Searching for "{query}"', { query: query.trim() }),
        scope: 'annotate.search'
      },
      async job => {
        await searchAndHighlightMatches(query, matchCase, job);
      }
    );

  return (
    <>
      <Field label={t('tool.annotate.findText')}>
        {id => (
          <TextInput
            id={id}
            value={query}
            placeholder={t('tool.annotate.findPlaceholder')}
            onInput={event => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && query.trim() && doc) void highlightMatches();
            }}
          />
        )}
      </Field>
      <Checkbox label={t('tool.annotate.matchCase')} checked={matchCase} onChange={setMatchCase} />
      <Button
        variant="secondary"
        icon={Search}
        disabled={!query.trim() || !doc}
        onClick={() => void highlightMatches()}
      >
        {t('tool.annotate.highlightEvery')}
      </Button>

      <hr className={panelStyles.divider} />

      <RadioGroup
        legend={t('tool.annotate.tool')}
        name="annotateTool"
        value={activeAnnotationTool.value}
        onChange={val => (activeAnnotationTool.value = val as AnnotationType)}
        options={[
          { value: 'freehand', label: t('tool.annotate.freehand') },
          { value: 'highlight', label: t('tool.annotate.highlight') },
          { value: 'rectangle', label: t('tool.annotate.rectangle') },
          { value: 'ellipse', label: t('tool.annotate.ellipse') },
          { value: 'arrow', label: t('tool.annotate.arrow') },
          { value: 'text', label: t('tool.annotate.text') },
          { value: 'sticky', label: t('tool.annotate.sticky') },
          { value: 'whiteout', label: t('tool.annotate.whiteout') }
        ]}
      />

      <div className={panelStyles.section}>
        <label className={panelStyles.label}>{t('tool.annotate.color')}</label>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-xs)',
            flexWrap: 'wrap',
            marginTop: 'var(--space-xs)'
          }}
        >
          {ANNOTATION_COLORS.map(color => {
            const active = annotationColor.value === color;
            return (
              <button
                key={color}
                type="button"
                onClick={() => (annotationColor.value = color)}
                aria-pressed={active}
                style={{
                  width: 'var(--space-xl)',
                  height: 'var(--space-xl)',
                  borderRadius: 'var(--radius-pill)',
                  border: active ? '3px solid var(--primary)' : '1px solid var(--border-control)',
                  backgroundColor: color,
                  cursor: 'pointer'
                }}
                aria-label={t('Select color {color}', { color: t(COLOR_NAME_KEYS[color]) })}
              />
            );
          })}
        </div>
      </div>

      <div className={panelStyles.section}>
        <label className={panelStyles.label} htmlFor="stroke-width">
          {t('tool.annotate.strokeWidth')}
        </label>
        <Slider
          id="stroke-width"
          min={1}
          max={20}
          value={annotationStrokeWidth.value}
          onChange={val => (annotationStrokeWidth.value = val)}
        />
      </div>

      <hr className={panelStyles.divider} />
      <Button
        variant="secondary"
        icon={FileText}
        disabled={!doc}
        onClick={() => void handleExportSummary()}
      >
        {t('Export annotation summary')}
      </Button>

      <FlattenOption mode="annotate" />
    </>
  );
}

/**
 * Every annotation the summary lists for `current`: the drawing layer's notes
 * on its pages (another document's stale keys are skipped, HRD-24 §12.3) and
 * the document's own annotations.
 */
export function summaryAnnotationsFor(current: StaplerDoc): SummaryAnnotation[] {
  const currentPageKeys = new Set(current.pages.map(page => page.key));
  const layer: SummaryAnnotation[] = [];
  for (const [pageKey, anns] of Object.entries(pageAnnotations.value)) {
    if (!currentPageKeys.has(pageKey)) continue;
    for (const ann of anns) layer.push({ ...ann, pageKey });
  }
  const own: SummaryAnnotation[] = (current.annotations || []).map(a => ({
    id: a.id,
    type: a.type,
    x: a.x,
    y: a.y,
    rect: { x: a.x, y: a.y, width: a.width, height: a.height },
    text: a.data,
    pageKey: a.pageKey
  }));
  return [...layer, ...own];
}
