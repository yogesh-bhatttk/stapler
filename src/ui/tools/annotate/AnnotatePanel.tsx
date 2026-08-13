import { useTranslation } from '../../../core/i18n';
import { ANNOTATION_COLORS } from '../../../core/doc-colors';
import { RadioGroup, Slider } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
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

  return (
    <>
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
    </>
  );
}
