import { useId, type ReactNode } from "react";

/** Bloco com título dentro de uma seção (ex.: "Voz", "Transmissão de tela"). */
export function SettingsGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-group" aria-labelledby={id}>
      <h3 id={id} className="settings-group__title">
        {title}
      </h3>
      {description && <p className="settings-group__description">{description}</p>}
      <div className="settings-group__body">{children}</div>
    </section>
  );
}

/** Interruptor com rótulo visível e explicação (guia visual §6.9). */
export function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
  action,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** Botão extra à direita (ex.: "Ouvir"). Fica fora do <label> para não alternar o interruptor. */
  action?: ReactNode;
}) {
  const hintId = useId();
  return (
    <div className={disabled ? "settings-switch settings-switch--disabled" : "settings-switch"}>
      <label className="settings-switch__label">
        <span className="choice__text">
          <span className="settings-switch__title">{label}</span>
          {hint && (
            <span id={hintId} className="choice__hint">
              {hint}
            </span>
          )}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
      {action}
    </div>
  );
}

/** Controle deslizante com o valor escrito ao lado (não depende só da posição). */
export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Explicação embaixo (ex.: por que está desativado). */
  hint?: string;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className={disabled ? "field settings-slider settings-slider--disabled" : "field settings-slider"}>
      <div className="settings-slider__head">
        <label htmlFor={id} className="field__label">
          {label}
        </label>
        <output htmlFor={id} className="settings-slider__value">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="settings-range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={format(value)}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  hint?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const hintId = useId();
  // o escolhido sumiu (fone desconectado): mostra que vai usar o padrão
  const known = options.some((option) => option.value === value);
  return (
    <div className="field">
      <label htmlFor={id} className="field__label">
        {label}
      </label>
      <select id={id} className="input settings-select" value={known ? value : "default"} aria-describedby={hint ? hintId : undefined} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && (
        <span id={hintId} className="field__hint">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Escolha única em cartões (rádio), como no diálogo de transmissão. */
export function RadioCards<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  columns = false,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; title: string; hint?: string }[];
  onChange: (value: T) => void;
  /** Lado a lado em telas largas (opções curtas). */
  columns?: boolean;
}) {
  return (
    <fieldset className={columns ? "choice-group settings-radio settings-radio--columns" : "choice-group settings-radio"}>
      <legend className="field__label">{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="choice">
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          <span className="choice__text">
            <span className="choice__title">{option.title}</span>
            {option.hint && <span className="choice__hint">{option.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Mensagem de status discreta (sucesso) ou de erro, lida pelo leitor de tela. */
export function FormStatus({ status }: { status: { kind: "ok" | "error"; text: string } | null }) {
  if (!status) return null;
  return status.kind === "error" ? (
    <p className="form-error" role="alert">
      {status.text}
    </p>
  ) : (
    <p className="settings-ok" role="status">
      {status.text}
    </p>
  );
}
