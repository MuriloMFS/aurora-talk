import { useEffect, useState } from "react";
import { PTT_RELEASE_MAX, PTT_RELEASE_MIN, pttCodeFromEvent, pttKeyLabel, type PlatformInfo } from "@aurora/platform";
import { patchSettings, useSettings, type InputMode } from "../../state/settings";
import { RadioCards, SettingsGroup, SliderField } from "./controls";

const MODES: { value: InputMode; title: string; hint: string }[] = [
  { value: "voice", title: "Detecção de voz", hint: "O microfone fica aberto e transmite quando você fala." },
  { value: "ptt", title: "Apertar para falar", hint: "O microfone só abre enquanto você segura uma tecla ou um botão do mouse." },
];

const ms = (value: number) => (value === 0 ? "Sem atraso" : `${value} ms`);

/** Configurações → Voz → modo de entrada e tecla do apertar para falar. */
export function PushToTalkSettings({ platform }: { platform: PlatformInfo | null }) {
  const voice = useSettings().voice;
  const [capturing, setCapturing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Escolhendo a tecla: a próxima tecla ou botão (meio/laterais) vira a tecla; Esc cancela.
  useEffect(() => {
    if (!capturing) return;
    const onInput = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCapturing(false);
        return;
      }
      const code = pttCodeFromEvent(event);
      if (event instanceof MouseEvent && event.button < 1) return; // clique esquerdo: deixa clicar em "Cancelar"
      event.preventDefault();
      event.stopPropagation();
      if (!code) {
        setNotice(event instanceof MouseEvent ? "Esse botão não serve: use o do meio ou um lateral do mouse." : "Essa tecla não serve. Escolha outra.");
        return;
      }
      const label = pttKeyLabel(code, event instanceof KeyboardEvent ? event.key : undefined);
      patchSettings("voice", { pttKey: code, pttKeyLabel: label, inputMode: "ptt" });
      setNotice(null);
      setCapturing(false);
    };
    const block = (event: Event) => event.preventDefault(); // botão direito não abre menu durante a escolha
    window.addEventListener("keydown", onInput, { capture: true });
    window.addEventListener("mousedown", onInput, { capture: true });
    window.addEventListener("contextmenu", block, { capture: true });
    return () => {
      window.removeEventListener("keydown", onInput, { capture: true });
      window.removeEventListener("mousedown", onInput, { capture: true });
      window.removeEventListener("contextmenu", block, { capture: true });
    };
  }, [capturing]);

  const keyLabel = voice.pttKey ? (voice.pttKeyLabel ?? pttKeyLabel(voice.pttKey)) : null;
  const global = platform?.pushToTalk === "global";

  return (
    <SettingsGroup
      title="Modo de entrada"
      description={
        global
          ? "Apertar para falar funciona com o Aurora em segundo plano, inclusive com um jogo na frente. O Aurora observa só a tecla escolhida, e só enquanto você está numa sala de voz."
          : "No navegador, apertar para falar só funciona com a janela do Aurora em foco. No app instalado, funciona em qualquer janela."
      }
    >
      <RadioCards legend="Como o microfone abre" name="input-mode" value={voice.inputMode} options={MODES} onChange={(inputMode) => patchSettings("voice", { inputMode })} />
      {voice.inputMode === "ptt" && (
        <>
          <div className="ptt-key">
            <div className="ptt-key__text">
              <span className="settings-switch__title">Tecla</span>
              <span className="choice__hint" aria-live="polite">
                {capturing ? "Aperte a tecla ou o botão do mouse que quer usar (Esc cancela)." : keyLabel ? <kbd className="kbd">{keyLabel}</kbd> : "Nenhuma escolhida: o microfone fica como na detecção de voz."}
              </span>
            </div>
            <button type="button" className="button button--secondary" aria-pressed={capturing} onClick={() => setCapturing((on) => !on)}>
              {capturing ? "Cancelar" : keyLabel ? "Trocar a tecla" : "Escolher a tecla"}
            </button>
          </div>
          {notice && (
            <p className="form-error" role="alert">
              {notice}
            </p>
          )}
          <SliderField
            label="Atraso ao soltar"
            value={voice.pttReleaseMs}
            min={PTT_RELEASE_MIN}
            max={PTT_RELEASE_MAX}
            step={20}
            format={ms}
            onChange={(pttReleaseMs) => patchSettings("voice", { pttReleaseMs })}
          />
          <p className="field__hint">
            O microfone continua aberto por esse tempo depois de soltar, para não cortar o fim da frase.
            {global && " Se um jogo roda como administrador, o Windows esconde as teclas dele: abra o Aurora também como administrador."}
          </p>
        </>
      )}
    </SettingsGroup>
  );
}
