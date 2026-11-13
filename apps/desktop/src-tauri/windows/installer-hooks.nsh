; Ganchos do instalador (NSIS) do Aurora.
;
; Instalacao normal (com janela): ao terminar, cria o atalho na area de trabalho, abre o app e fecha o
; instalador, sem a tela final de "Concluir". A atualizacao automatica (modo passivo, /UPDATE) e a
; instalacao silenciosa continuam como o Tauri faz: o app volta sozinho pelo /R.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
  ${AndIf} $UpdateMode <> 1
    Call CreateOrUpdateDesktopShortcut
    Call RunMainBinary
    Quit
  ${EndIf}
!macroend
