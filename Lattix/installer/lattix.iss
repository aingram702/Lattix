; Inno Setup script for Lattix.
;
; Wraps the PyInstaller onedir bundle (dist\Lattix) into a single, standalone
; LattixSetup.exe with Start Menu / Desktop shortcuts. No Python required on
; the target machine — the runtime is bundled by PyInstaller.
;
; Build from the project root after PyInstaller has produced dist\Lattix:
;     iscc installer\lattix.iss
;
; Requires Inno Setup 6+ (https://jrsoftware.org/isinfo.php).

#define MyAppName "Lattix"
#define MyAppVersion "1.1.0"
#define MyAppPublisher "Lattix"
#define MyAppExeName "Lattix.exe"

[Setup]
AppId={{B7F2A3C1-9E44-4D2B-9C1A-7A1B2C3D4E5F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; Relative paths below (Source, SetupIconFile, OutputDir) resolve against
; SourceDir, which is the project root (the parent of this installer\ folder).
SourceDir=..
OutputDir=installer\Output
OutputBaseFilename=LattixSetup
SetupIconFile=installer\lattix.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; The whole PyInstaller onedir bundle.
Source: "dist\Lattix\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
