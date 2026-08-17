import { useState } from 'preact/hooks';
import { Search, FileText } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { exportAnnotationSummary, type SummaryAnnotation } from '../../../core/annotation-summary';
import { pageAnnotations } from './state';
import { useTranslation } from '../../../core/i18n';
import { ANNOTATION_COLORS } from '../../../core/doc-colors';
import { notify } from '../../../core/notify';
import { activeDoc } from '../../../core/store';
import { Button } from '../../components/Button';
import { Checkbox, Field, RadioGroup, Slider, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
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
  [ANNOTATION_COLORS[0]]: 'tool.annotate.colorYellow',
  [ANNOTATION_COLORS[1]]: 'tool.annotate.colorRed',
  [ANNOTATION_COLORS[2]]: 'tool.annotate.colorGreen',
  [ANNOTATION_COLORS[3]]: 'tool.annotate.colorBlue',
  [ANNOTATION_COLORS[4]]: 'tool.annotate.colorBlack',
  [ANNOTATION_COLORS[5]]: 'tool.annotate.colorWhite'
};

export function AnnotatePanel() {
  const t = useTranslation();
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const { run } = useJob();
  const doc = activeDoc.value;

  /**
   * ANN-03 — every match becomes a highlight on ANN-01's layer.
   *
   * The search itself is `findTextRegions`, the same worker call RED's
   * find-and-mark uses; only what is built from the result differs. The helper
   * keeps the search one undo step and drops stale results if the active
   * document changes before the worker returns.
   */
  const handleExportSummary = async () => {
    const current = activeDoc.value;
    if (!current) return;
    const currentPageKeys = new Set(current.pages.map(page => page.key));

    const allLayerAnns: SummaryAnnotation[] = [];
    for (const [pageKey, anns] of Object.entries(pageAnnotations.value)) {
      if (!currentPageKeys.has(pageKey)) continue;
      for (const ann of anns) {
        allLayerAnns.push({ ...ann, pageKey });
      }
    }

    const docAnns: SummaryAnnotation[] = (current.annotations || []).map(a => ({
      id: a.id,
      type: a.type,
      x: a.x,
      y: a.y,
      rect: { x: a.x, y: a.y, width: a.width, height: a.height },
      text: a.data,
      pageKey: a.pageKey
    }));

    const combined = [...allLayerAnns, ...docAnns];
    if (combined.length === 0) {
      notify('warning', 'No annotations to export.');
      return;
    }

    try {
      const summaryBytes = await exportAnnotationSummary(current, combined);
      const fileStem = current.name.replace(/\.[^.]+$/, '') || 'document';
      const saved = await platform.saveFileAs(summaryBytes, `${fileStem}-annotation-summary.pdf`);
      if (saved) {
        notify('success', 'Exported annotation summary PDF.');
      }
    } catch (err) {
      notify('danger', 'Could not export annotation summary.', {
        detail: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const highlightMatches = () =>
    run({ label: `Searching for "${query.trim()}"`, scope: 'annotate.search' }, async job => {
      await searchAndHighlightMatches(query, matchCase, job);
    });

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
              if (event.key === 'Enter' && query.trim() && doc) highlightMatches();
            }}
          />
        )}
      </Field>
      <Checkbox label={t('tool.annotate.matchCase')} checked={matchCase} onChange={setMatchCase} />
      <Button
        variant="secondary"
        icon={Search}
        disabled={!query.trim() || !doc}
        onClick={highlightMatches}
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
                aria-label={`${t('tool.annotate.selectColor')} ${t(COLOR_NAME_KEYS[color])}`}
              />
            );
          })}
        </div>
      </div>

      <div className={panelStyles.section}>
        <label className={panelStyles.label}>{t('tool.annotate.strokeWidth')}</label>
        <Slider
          id="stroke-width"
          min={1}
          max={20}
          value={annotationStrokeWidth.value}
          onChange={val => (annotationStrokeWidth.value = val)}
        />
      </div>

      <hr className={panelStyles.divider} />
      <Button variant="secondary" icon={FileText} disabled={!doc} onClick={handleExportSummary}>
        Export annotation summary
      </Button>

      <FlattenOption mode="annotate" />
    </>
  );
}
