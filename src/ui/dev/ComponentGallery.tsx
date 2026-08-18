import { translate } from '../../core/i18n';
/**
 * DS-03 — every primitive in every state, for visual review and an axe-core pass.
 * Not linked from the app; reachable only at `#/dev/components`.
 */
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Copy, Download, Settings, Star, Trash2 } from 'lucide-preact';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { Badge } from '../components/Badge';
import { Chip } from '../components/Chip';
import { Tooltip } from '../components/Tooltip';
import { Skeleton } from '../components/Skeleton';
import { Tabs } from '../components/Tabs';
import { ContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { Modal } from '../components/Modal';
import {
  Checkbox,
  Field,
  NumberInput,
  NumberStepper,
  RadioGroup,
  SegmentedControl,
  Select,
  Slider,
  TextArea,
  TextInput
} from '../components/Field';
import { EmptyState, ProgressBar, SizeDelta } from '../components/Feedback';
import { notify, confirmAction } from '../../core/notify';
import { resolvedTheme, setTheme } from '../theme';
import styles from './ComponentGallery.module.css';

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <div className={styles.row}>{children}</div>
    </section>
  );
}

export function ComponentGallery() {
  const [selectValue, setSelectValue] = useState<'a' | 'b' | 'c'>('a');
  const [radioValue, setRadioValue] = useState<'x' | 'y'>('x');
  const [sliderValue, setSliderValue] = useState(60);
  const [checked, setChecked] = useState(true);
  const [stepperValue, setStepperValue] = useState(4);
  const [segmentValue, setSegmentValue] = useState<'grid' | 'list'>('grid');
  const [chipSelected, setChipSelected] = useState(false);
  const [tabId, setTabId] = useState('one');
  const [modalOpen, setModalOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const menuItems: ContextMenuItem[] = [
    { label: 'Duplicate', icon: Copy, onSelect: () => notify('info', translate('Duplicated')) },
    { label: 'Download', icon: Download, onSelect: () => notify('info', translate('Downloaded')) },
    { label: 'Disabled item', icon: Star, disabled: true, onSelect: () => {} },
    {
      label: 'Delete',
      icon: Trash2,
      danger: true,
      onSelect: () => notify('danger', translate('Deleted'))
    }
  ];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Component gallery</h1>
        <p className={styles.subtitle}>DS-03 — every primitive, every state, both themes.</p>
        <SegmentedControl
          legend="Theme"
          name="gallery-theme"
          value={resolvedTheme.value}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
          onChange={setTheme}
        />
      </header>

      <Section title="Button">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="tertiary">Tertiary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="primary" icon={Star}>
          With icon
        </Button>
        <Button variant="primary" size="compact">
          Compact
        </Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
      </Section>

      <Section title="IconButton">
        <IconButton icon={Settings} aria-label={translate('Settings')} />
        <IconButton icon={Settings} aria-label={translate('Settings')} active />
        <IconButton icon={Settings} aria-label={translate('Settings')} size="compact" />
        <IconButton icon={Settings} aria-label={translate('Settings')} disabled />
      </Section>

      <Section title="Badge">
        <Badge>Neutral</Badge>
        <Badge variant="success">Success</Badge>
      </Section>

      <Section title="Chip">
        <Chip>Static</Chip>
        <Chip onRemove={() => notify('info', translate('Removed'))} removeLabel="Remove tag">
          Removable
        </Chip>
        <Chip selected={chipSelected} onClick={() => setChipSelected(v => !v)}>
          Toggleable
        </Chip>
        <Chip onClick={() => {}} disabled>
          Disabled
        </Chip>
      </Section>

      <Section title="Tooltip">
        <Tooltip content="Appears on hover or focus">
          <Button variant="secondary">Hover or Tab to me</Button>
        </Tooltip>
      </Section>

      <Section title="Field primitives">
        <Field label="Text input" hint="A hint line">
          {id => <TextInput id={id} placeholder="Type here" />}
        </Field>
        <Field label="Number input">{id => <NumberInput id={id} value={10} />}</Field>
        <Field label="Number stepper" value={stepperValue}>
          {id => (
            <NumberStepper
              id={id}
              value={stepperValue}
              min={0}
              max={10}
              onChange={setStepperValue}
              ariaLabel="Number stepper"
            />
          )}
        </Field>
        <Field label="Select">
          {id => (
            <Select
              id={id}
              value={selectValue}
              onChange={setSelectValue}
              options={[
                { value: 'a', label: 'Option A' },
                { value: 'b', label: 'Option B' },
                { value: 'c', label: 'Option C' }
              ]}
            />
          )}
        </Field>
        <Field label="Slider" value={sliderValue}>
          {id => (
            <Slider
              id={id}
              min={0}
              max={100}
              value={sliderValue}
              onChange={setSliderValue}
              scale={['Low', 'High']}
              ariaLabel="Slider"
            />
          )}
        </Field>
        <Field label="Text area">{id => <TextArea id={id} placeholder="Multiple lines" />}</Field>
      </Section>

      <Section title="Checkbox / Radio / SegmentedControl">
        <Checkbox label="Checked" checked={checked} onChange={setChecked} />
        <Checkbox label="Unchecked" checked={false} onChange={() => {}} />
        <Checkbox label="Disabled" checked={false} onChange={() => {}} disabled />
        <RadioGroup
          legend="Radio group"
          name="gallery-radio"
          value={radioValue}
          onChange={setRadioValue}
          options={[
            { value: 'x', label: 'Option X', hint: 'With a hint' },
            { value: 'y', label: 'Option Y' }
          ]}
        />
        <SegmentedControl
          legend="View"
          name="gallery-segment"
          value={segmentValue}
          onChange={setSegmentValue}
          options={[
            { value: 'grid', label: 'Grid' },
            { value: 'list', label: 'List' }
          ]}
        />
      </Section>

      <Section title="Tabs">
        <Tabs
          ariaLabel="Gallery tabs"
          activeId={tabId}
          onChange={setTabId}
          items={[
            { id: 'one', label: 'First' },
            { id: 'two', label: 'Second' },
            { id: 'three', label: 'Third' }
          ]}
        />
      </Section>

      <Section title="ContextMenu">
        <Button
          variant="secondary"
          onClick={event => {
            const rect = (event.target as HTMLElement).getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          Open menu
        </Button>
        {menu && (
          <ContextMenu items={menuItems} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
        )}
      </Section>

      <Section title="Skeleton">
        <Skeleton variant="text" width={160} />
        <Skeleton variant="circle" />
        <Skeleton variant="block" width={120} height={72} />
      </Section>

      <Section title="ProgressBar">
        <ProgressBar label="Determinate" value={0.4} />
        <ProgressBar label="Indeterminate" value={null} />
      </Section>

      <Section title="SizeDelta">
        <SizeDelta before={4_200_000} after={1_100_000} />
        <SizeDelta before={1_000_000} after={998_000} />
      </Section>

      <Section title="EmptyState">
        <EmptyState
          title="Nothing here yet"
          body="A description of why, and what to do next."
          action={<Button variant="secondary">Take action</Button>}
        />
      </Section>

      <Section title="Modal / Toast / Confirm">
        <Button variant="secondary" onClick={() => setModalOpen(true)}>
          Open modal
        </Button>
        <Button
          variant="secondary"
          onClick={() => notify('success', translate('Saved'), { detail: 'Done.' })}
        >
          Show toast
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            void confirmAction({
              title: 'Delete this?',
              body: 'This cannot be undone.',
              tone: 'danger'
            })
          }
        >
          Show confirm dialog
        </Button>
      </Section>

      {modalOpen && (
        <Modal
          title="Example modal"
          onClose={() => setModalOpen(false)}
          footer={
            <>
              <Button variant="tertiary" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setModalOpen(false)}>
                Confirm
              </Button>
            </>
          }
        >
          <p>Modal body content.</p>
        </Modal>
      )}
    </div>
  );
}
