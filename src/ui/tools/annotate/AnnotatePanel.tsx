import { useState } from 'preact/hooks';
import { Search, FileText } from 'lucide-preact';
import { platform } from '../../../platform/current';
import { exportAnnotationSummary, type SummaryAnnotation } from '../../../core/annotation-summary';
import { pageAnnotations } from './state';
import { useTranslation } from '../../../core/i18n';
import { ANNOTATION_COLORS } from '../../../core/doc-colors';
import { commit } from '../../../core/history';
import { highlightsForRegions, type HighlightPage } from '../../../core/highlight';
import { notify } from '../../../core/notify';
import { currentDocumentBytes, findTextRegions } from '../../../core/operations';
import { displayedAspectRatio } from '../../../core/rotation';
import { activeDoc, sources } from '../../../core/store';
import { Button } from '../../components/Button';
import { Checkbox, Field, RadioGroup, Slider, TextInput } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import { useJob } from '../../useJob';
import { FlattenOption } from '../FlattenOption';
import {
  activeAnnotationTool,
  addAnnotations,
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
   * find-and-mark uses; only what is built from the result differs. `commit()` is
   * called once before the batch, so the whole search is one undo step (DOC-06).
   */
  const handleExportSummary = async () => {
    const current = activeDoc.value;
    if (!current) return;

    const allLayerAnns: SummaryAnnotation[] = [];
    for (const [pageKey, anns] of Object.entries(pageAnnotations.value)) {
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
      const current = activeDoc.value;
      if (!current) return;
      const bytes = await currentDocumentBytes(job);
      const found = await findTextRegions(bytes, query.trim(), matchCase, job);
      if (found.length === 0) {
        notify('warning', `No matches for "${query.trim()}".`);
        return;
      }

      // `findText` indexes the pages of the document just composed, which is
      // `doc.pages` in order, so the page at a match's index is the page whose
      // key the annotation belongs to.
      const pages: HighlightPage[] = current.pages.map(page => {
        const size = sources.value[page.sourceDocId]?.pageSizes[page.sourceIndex];
        return {
          key: page.key,
          aspect: 1 / displayedAspectRatio(size?.width ?? 0, size?.height ?? 0, page.rotation)
        };
      });

      const { highlights, unplaced } = highlightsForRegions(found, pages, annotationColor.value);
      if (highlights.length === 0) {
        notify('warning', `No matches for "${query.trim()}" on any page of this document.`);
        return;
      }
      commit();
      addAnnotations(highlights);
      notify('info', `Highlighted ${highlights.length} match(es).`, {
        detail:
          unplaced > 0
            ? `${unplaced} match(es) fell outside this document's pages and were not highlighted. Undo removes the whole search.`
            : 'Undo removes the whole search in one step; each highlight is an ordinary annotation you can move or delete.'
      });
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
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
          {ANNOTATION_COLORS.map(color => (
            <button
              key={color}
              type="button"
              onClick={() => (annotationColor.value = color)}
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '16px',
                border:
                  annotationColor.value === color
                    ? '3px solid var(--primary)'
                    : '1px solid var(--border-control)',
                backgroundColor: color,
                cursor: 'pointer'
              }}
              aria-label={`${t('tool.annotate.selectColor')} ${t(COLOR_NAME_KEYS[color])}`}
            />
          ))}
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

      <FlattenOption />
    </>
  );
}
