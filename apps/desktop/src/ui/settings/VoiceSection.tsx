import { useEffect, useRef, useState } from "react";
import { listVoiceDevices, onAudioDevicesChange, startVoiceMicrophoneTest, type AudioDevices, type MicrophoneTest, type PlatformInfo, type ScreenShareQuality } from "@aurora/platform";
import { effectiveProcessing, patchSettings, useSettings, type InputProfile, type VoicePrefs } from "../../state/settings";
import { QUALITIES, loadScreenShareOptions, saveScreenShareOptions, spec } from "../ScreenShareDialog";
import { voiceSettingsOf } from "../../voice-settings";
import { RadioCards, SelectField, SettingsGroup, SliderField, SwitchRow } from "./controls";
import { PushToTalkSettings } from "./PushToTalkSettings";

const PROFILES: { value: InputProfile; title: string; hint: string }[] = [
  { value: "isolation", title: "Isolar a voz", hint: "Tira eco, ruído de fundo e equilibra o volume. Melhor para a maioria." },
  { value: "studio", title: "Som puro", hint: "Sem nenhum tratamento. Para microfones bons em lugar silencioso (ou música)." },
  { value: "custom", title: "Escolher cada ajuste", hint: "Ligue e desligue cada tratamento abaixo." },
];

const percent = (value: number) => `${value}%`;

export function VoiceSection({ platform }: { platform: PlatformInfo | null }) {
  const settings = useSettings();
  const voice = settings.voice;
  const setVoice = (patch: Partial<VoicePrefs>) => patchSettings("voice", patch);

  // ---- dispositivos (atualiza ao ligar/desligar um fone) ----
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] });
  const [deviceError, setDeviceError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      listVoiceDevices(platform)
        .then((found) => alive && setDevices(found))
        .catch(() => alive && setDeviceError("Não foi possível listar os dispositivos de áudio. Confira se o microfone está conectado."));
    void load();
    const stop = onAudioDevicesChange(load);
    return () => {
      alive = false;
      stop();
    };
  }, [platform?.media]);
  const native = platform?.media === "native";
  const NATIVE_VOLUME_HINT = "No app para Linux, ajuste este volume pelo controle de som do sistema, por enquanto.";
  const withDefault = (list: AudioDevices["inputs"]) => (list.length > 0 ? list : [{ id: "default", label: "Padrão do Windows" }]).map((d) => ({ value: d.id, label: d.label }));

  // ---- teste do microfone ----
  const testRef = useRef<MicrophoneTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const [level, setLevel] = useState(0);
  const [testError, setTestError] = useState<string | null>(null);
  const stopTest = () => {
    testRef.current?.stop();
    testRef.current = null;
    setTesting(false);
    setMonitor(false);
    setLevel(0);
  };
  const startTest = async () => {
    setTestError(null);
    try {
      // no motor nativo, o microfone é medido pelo nome que a lista mostra ("default: …" = o padrão)
      const deviceName =
        devices.inputs.find((d) => d.id === voice.inputDeviceId)?.label ?? devices.inputs.find((d) => d.label.startsWith("default:"))?.label ?? "default:";
      testRef.current = await startVoiceMicrophoneTest(platform, voiceSettingsOf(voice), deviceName);
      setTesting(true);
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      setTestError(
        name === "NotAllowedError"
          ? "O Aurora não tem permissão para usar o microfone. Libere o acesso e tente de novo."
          : "Não foi possível abrir o microfone. Confira se ele está conectado e tente de novo.",
      );
    }
  };
  // mudou microfone/processamento/volume no meio do teste: reabre com a escolha nova
  const testKey = JSON.stringify(voiceSettingsOf(voice));
  const testKeyRef = useRef(testKey);
  useEffect(() => {
    if (testKeyRef.current === testKey) return;
    testKeyRef.current = testKey;
    if (!testRef.current) return;
    stopTest();
    void startTest();
  }, [testKey]); // reinicia só quando a escolha muda
  useEffect(() => {
    if (!testing) return;
    let frame = 0;
    const tick = () => {
      setLevel(testRef.current?.level() ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [testing]);
  useEffect(() => () => testRef.current?.stop(), []);

  // ---- transmissão de tela (mesma escolha que o diálogo lembra) ----
  const [share, setShare] = useState(loadScreenShareOptions);
  const updateShare = (patch: Partial<typeof share>) => {
    const next = { ...share, ...patch };
    setShare(next);
    saveScreenShareOptions(next);
  };

  const processing = effectiveProcessing(voice);
  const levelPercent = Math.round(level * 100);

  return (
    <>
      <SettingsGroup title="Voz">
        {deviceError && (
          <p className="form-error" role="alert">
            {deviceError}
          </p>
        )}
        <div className="settings-columns">
          <SelectField label="Microfone" value={voice.inputDeviceId} options={withDefault(devices.inputs)} onChange={(id) => setVoice({ inputDeviceId: id })} />
          <SelectField
            label="Alto-falante"
            value={voice.outputDeviceId}
            options={withDefault(devices.outputs)}
            hint={platform?.kind === "browser" ? "No navegador, o som pode sair sempre no padrão do sistema." : undefined}
            onChange={(id) => setVoice({ outputDeviceId: id })}
          />
          <SliderField label="Volume do microfone" value={voice.inputVolume} min={0} max={200} step={5} format={percent} disabled={native} hint={native ? NATIVE_VOLUME_HINT : undefined} onChange={(v) => setVoice({ inputVolume: v })} />
          <SliderField label="Volume de quem fala" value={voice.outputVolume} min={0} max={100} step={5} format={percent} disabled={native} hint={native ? NATIVE_VOLUME_HINT : undefined} onChange={(v) => setVoice({ outputVolume: v })} />
        </div>

        <div className="mic-test">
          <button type="button" className={testing ? "button button--secondary" : "button button--primary"} onClick={() => (testing ? stopTest() : void startTest())}>
            {testing ? "Parar o teste" : "Testar o microfone"}
          </button>
          <div
            className="mic-test__meter"
            role="meter"
            aria-label="Nível do microfone"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={levelPercent}
            aria-valuetext={testing ? `${levelPercent}%` : "Teste parado"}
          >
            <span className="mic-test__fill" style={{ inlineSize: `${levelPercent}%` }} />
          </div>
        </div>
        {testing && !native && (
          <SwitchRow
            label="Ouvir minha voz"
            hint="Use fone de ouvido para não dar microfonia."
            checked={monitor}
            onChange={(on) => {
              setMonitor(on);
              testRef.current?.setMonitor(on);
            }}
          />
        )}
        {testError && (
          <p className="form-error" role="alert">
            {testError}
          </p>
        )}
        <p className="field__hint">Fale normalmente: a barra deve ficar mais ou menos no meio. Se ficar sempre no fim, baixe o volume do microfone.</p>
      </SettingsGroup>

      <PushToTalkSettings platform={platform} />

      <SettingsGroup title="Tratamento do microfone">
        <RadioCards legend="Perfil de entrada" name="voice-profile" value={voice.profile} options={PROFILES} onChange={(profile) => setVoice({ profile })} />
        <SwitchRow
          label="Cancelamento de eco"
          hint="Evita que o som do seu alto-falante volte pelo microfone."
          checked={processing.echoCancellation}
          disabled={voice.profile !== "custom"}
          onChange={(on) => setVoice({ echoCancellation: on })}
        />
        <SwitchRow
          label="Supressão de ruído"
          hint="Abafa teclado, ventilador e barulho de fundo."
          checked={processing.noiseSuppression}
          disabled={voice.profile !== "custom"}
          onChange={(on) => setVoice({ noiseSuppression: on })}
        />
        <SwitchRow
          label="Ganho automático"
          hint="Aumenta quem fala baixo e segura quem fala alto."
          checked={processing.autoGainControl}
          disabled={voice.profile !== "custom"}
          onChange={(on) => setVoice({ autoGainControl: on })}
        />
      </SettingsGroup>

      <SettingsGroup title="Transmissão de tela" description="Vem marcado assim quando você clica em compartilhar a tela.">
        <RadioCards<ScreenShareQuality>
          legend="Qualidade"
          name="share-quality"
          value={share.quality}
          columns
          options={QUALITIES.map((q) => ({ value: q.value, title: `${q.title} · ${spec(q.value)}`, hint: q.hint }))}
          onChange={(quality) => updateShare({ quality })}
        />
        <SwitchRow
          label="Transmitir o som do computador"
          hint={platform?.systemAudio === "native" ? "As vozes da sala ficam de fora (sem eco)." : "Depende da opção de áudio do seletor do sistema."}
          checked={share.systemAudio}
          onChange={(systemAudio) => updateShare({ systemAudio })}
        />
      </SettingsGroup>
    </>
  );
}
