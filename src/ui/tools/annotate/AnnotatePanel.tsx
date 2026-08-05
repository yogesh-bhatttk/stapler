import { useTranslation } from '../../../core/i18n';
import { RadioGroup, Slider } from '../../components/Field';
import { panelStyles } from '../../shell/OptionsPanel';
import {
  activeAnnotationTool,
  annotationColor,
  annotationStrokeWidth,
  AnnotationType
} from './state';

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
          { value: 'text', label: t('tool.annotate.text') }
        ]}
      />

      <div className={panelStyles.section}>
        <label className={panelStyles.label}>{t('tool.annotate.color')}</label>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
          {[
            '#' + 'FFEB3B',
            '#' + 'F44336',
            '#' + '4CAF50',
            '#' + '2196F3',
            '#' + '000000',
            '#' + 'FFFFFF'
          ].map(color => (
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
              aria-label={`Select color ${color}`}
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
