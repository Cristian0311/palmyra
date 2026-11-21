; PALMYRA POS se instala siempre para el usuario actual (sin UAC y sin la
; página "todos/yo"): así las actualizaciones pueden correr con /S y el POS
; nunca queda a medio instalar esperando una decisión.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
