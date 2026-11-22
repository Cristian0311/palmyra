; PALMYRA POS se instala siempre para el usuario actual (sin UAC y sin la
; página "todos/yo"): así las actualizaciones pueden correr con /S y el POS
; nunca queda a medio instalar esperando una decisión.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; ─── Acceso directo garantizado ───────────────────────────────────────────────
; electron-builder solo crea los accesos directos cuando la instalación es nueva
; o cuando el acceso anterior todavía existe (ver addDesktopLink en
; installSection.nsh). En una actualización automática el Setup corre con
; --updated y /S: ahí ${isUpdated} es verdadero y, si el usuario había borrado
; el icono del Escritorio, nunca se volvía a crear.
;
; Este macro corre al final de la sección de instalación (con los archivos ya
; copiados y el $INSTDIR definitivo) y recrea SIEMPRE ambos accesos directos:
; Escritorio y menú Inicio. CreateShortCut nunca aborta la instalación.
!macro palmyraCreateShortcuts
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  ; Identidad AppUserModelID: evita duplicados en la barra de tareas y fija el
  ; icono/anclaje correctos al .lnk recién creado.
  WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"

  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "${APP_ID}"

  ; Refresca el Escritorio sin esperar a que el usuario cierre sesión (F5 no
  ; siempre basta y el dueño debe ver el icono en el acto).
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customInstall
  !insertmacro palmyraCreateShortcuts
!macroend
