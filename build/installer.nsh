; Extra installer steps, included by electron-builder (nsis.include).
;
; #675: register the app as the COM server for its toast activator, so that
; pressing a button on a toast in the Windows Action Center can START the app
; when it is not running. The CLSID must equal TOAST_ACTIVATOR_CLSID in
; src/shared/app-identity.ts; src/main/packaging.test.ts checks that it does.
;
; Per-user (HKCU), like the install itself: no elevation. The Start-menu
; shortcut's own ToastActivatorCLSID property is written by the app at boot
; (src/main/toast-shortcut.ts), because NSIS's WinShell plugin cannot write it.

!define SB_TOAST_ACTIVATOR_CLSID "{B09A799F-F4F1-40E7-BD3A-A3CF14B0AF11}"

!macro customInstall
  WriteRegStr HKCU "Software\Classes\CLSID\${SB_TOAST_ACTIVATOR_CLSID}" "" "switchboard.ai toast activator"
  WriteRegStr HKCU "Software\Classes\CLSID\${SB_TOAST_ACTIVATOR_CLSID}\LocalServer32" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend

!macro customUnInstall
  ; not on an update: the new version's customInstall would only write it back
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\CLSID\${SB_TOAST_ACTIVATOR_CLSID}"
  ${endIf}
!macroend
