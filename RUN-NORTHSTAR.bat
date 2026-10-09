@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Northstar Editor

set "ROOT=%~dp0"
set "EDITOR=%ROOT%apps\editor"
set "PSD_BRIDGE=%ROOT%packages\psd-bridge"

pushd "%ROOT%" >nul 2>&1
if errorlevel 1 goto :root_error

rem Source builds are the default so the UI always matches the checked-out source.
rem Packaged builds are available only when explicitly requested with /package.
if /i "%~1"=="/package" goto :launch_packaged
if /i "%~1"=="--package" goto :launch_packaged
if not "%~1"=="" goto :usage_error
goto :developer_launch

:launch_packaged
rem The PowerShell helper validates PE headers, restores a missing extraction from
rem the existing ZIP, and waits for the packaged GUI process to return.
if not exist "%EDITOR%\scripts\m7-launch-check.ps1" goto :packaged_helper_missing
where powershell.exe >nul 2>&1
if errorlevel 1 goto :packaged_helper_missing
set "PACKAGED_STATUS=%TEMP%\northstar-launch-%RANDOM%-%RANDOM%.status"
if exist "%PACKAGED_STATUS%" del "%PACKAGED_STATUS%" >nul 2>&1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EDITOR%\scripts\m7-launch-check.ps1" -LaunchPackaged -StatusFile "%PACKAGED_STATUS%"
set "PACKAGED_RC=%ERRORLEVEL%"
if "%PACKAGED_RC%"=="0" goto :packaged_success
findstr /x /c:"launched" "%PACKAGED_STATUS%" >nul 2>&1
if not errorlevel 1 goto :packaged_process_result
goto :packaged_helper_error

:packaged_process_result
if "%PACKAGED_RC%"=="0" goto :packaged_success
set "LAUNCH_RC=%PACKAGED_RC%"
goto :packaged_launch_error

:packaged_helper_error
del "%PACKAGED_STATUS%" >nul 2>&1
echo [오류] 패키지 검사 도구가 종료 코드 %PACKAGED_RC%로 끝나 실행 상태를 확인하지 못했습니다.
echo [안내] 패키지 복구를 확인하거나 인수 없이 다시 실행해 현재 소스를 빌드하세요.
goto :failed

:packaged_helper_missing
echo [안내] Windows PowerShell을 찾을 수 없어 패키지 상태를 검사하지 못했습니다.
echo [안내] Windows PowerShell을 설치하거나 인수 없이 실행해 현재 소스를 빌드하세요.
goto :failed

:developer_launch
echo 현재 소스를 빌드한 뒤 Northstar Editor를 실행합니다...

where node >nul 2>&1
if errorlevel 1 goto :node_missing
call node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22||(major===22&&minor>=6)?0:1)" >nul 2>&1
if errorlevel 1 goto :node_old
where npm >nul 2>&1
if errorlevel 1 goto :npm_missing

echo Node.js version check passed. Checking project dependencies...
pushd "%PSD_BRIDGE%" >nul
if errorlevel 1 goto :psd_directory_error
call npm ls --depth=0 >nul 2>&1
if not errorlevel 1 goto :psd_dependencies_ready
echo PSD Bridge dependencies are missing. Installing them...
call npm ci
set "SETUP_RC=%ERRORLEVEL%"
if "%SETUP_RC%"=="0" goto :psd_dependencies_ready
popd
goto :install_psd_error
:psd_dependencies_ready
popd

pushd "%EDITOR%" >nul
if errorlevel 1 goto :editor_directory_error
call npm ls --depth=0 >nul 2>&1
if not errorlevel 1 goto :editor_dependencies_ready
echo Editor dependencies are missing. Installing them...
call npm ci
set "SETUP_RC=%ERRORLEVEL%"
if "%SETUP_RC%"=="0" goto :editor_dependencies_ready
popd
goto :install_editor_error
:editor_dependencies_ready

echo Building PSD Bridge...
call npm --prefix "%PSD_BRIDGE%" run build
set "BUILD_RC=%ERRORLEVEL%"
if "%BUILD_RC%"=="0" goto :psd_build_done
popd
goto :psd_build_error
:psd_build_done

echo Building Northstar Editor...
call npm run build
set "BUILD_RC=%ERRORLEVEL%"
if "%BUILD_RC%"=="0" goto :editor_build_done
popd
goto :editor_build_error
:editor_build_done

echo Starting Northstar Editor...
call npm run preview
set "LAUNCH_RC=%ERRORLEVEL%"
popd
popd
if not "%LAUNCH_RC%"=="0" goto :launch_error
exit /b 0

:packaged_success
del "%PACKAGED_STATUS%" >nul 2>&1
popd
exit /b 0

:root_error
echo [오류] 프로젝트 폴더를 열 수 없습니다.
echo 해결: RUN-NORTHSTAR.bat를 프로젝트 루트에 두고 다시 실행하세요.
goto :failed_without_popd

:usage_error
echo [사용법] RUN-NORTHSTAR.bat 또는 RUN-NORTHSTAR.bat /package
echo 기본 실행은 현재 소스를 빌드합니다. /package는 기존 Electron 패키지를 명시적으로 실행합니다.
goto :failed

:node_missing
echo [오류] Node.js가 설치되어 있지 않거나 PATH에서 찾을 수 없습니다.
echo 해결: https://nodejs.org/ 에서 Node.js 22.6 이상을 설치한 뒤 새 명령 창에서 실행하세요.
goto :failed

:node_old
echo [오류] Node.js 22.6 이상이 필요합니다. 현재 버전: 
node --version
echo 해결: https://nodejs.org/ 에서 Node.js 22.6 이상으로 업데이트하세요.
goto :failed

:npm_missing
echo [오류] npm을 PATH에서 찾을 수 없습니다.
echo 해결: Node.js 22.6 이상을 다시 설치하고 npm이 포함되었는지 확인하세요.
goto :failed

:install_psd_error
echo [오류] PSD Bridge 의존성을 설치하지 못했습니다 (exit %SETUP_RC%). 네트워크 연결과 npm 로그를 확인하세요.
goto :failed

:install_editor_error
echo [오류] Editor 의존성을 설치하지 못했습니다 (exit %SETUP_RC%). 네트워크 연결과 npm 로그를 확인하세요.
goto :failed

:psd_build_error
echo [오류] PSD Bridge 빌드에 실패했습니다 (exit %BUILD_RC%).
echo 해결: packages\psd-bridge에서 npm ci와 npm run build를 실행해 원인을 확인하세요.
goto :failed

:editor_build_error
echo [오류] Editor 빌드에 실패했습니다 (exit %BUILD_RC%).
echo 해결: apps\editor에서 npm ci와 npm run build를 실행해 원인을 확인하세요.
goto :failed

:launch_error
echo [오류] Electron Editor 실행이 종료 코드 %LAUNCH_RC%로 끝났습니다.
echo 해결: 위 npm 출력의 오류를 확인하고 앱 의존성 및 Windows 보안 정책을 점검하세요.
goto :failed_with_rc

:packaged_launch_error
if defined PACKAGED_STATUS del "%PACKAGED_STATUS%" >nul 2>&1
echo [오류] 패키지 Editor가 시작된 뒤 종료 코드 %LAUNCH_RC%로 끝났습니다.
echo 해결: 앱 실행 권한과 Windows 보안 정책을 확인하고 패키지를 다시 빌드하세요.
goto :failed_with_rc

:psd_directory_error
echo [오류] PSD Bridge 폴더를 열 수 없습니다: "%PSD_BRIDGE%"
echo 해결: 프로젝트 루트에 packages\psd-bridge 폴더가 있는지 확인하세요.
goto :failed

:editor_directory_error
echo [오류] Editor 폴더를 열 수 없습니다: "%EDITOR%"
echo 해결: 프로젝트 루트에 apps\editor 폴더가 있는지 확인하세요.
goto :failed

:failed
echo.
echo Northstar 실행에 실패했습니다. 위 해결 방법을 확인하세요.
:failed_without_popd
pause
exit /b 1

:failed_with_rc
echo.
echo Northstar 실행이 종료 코드 %LAUNCH_RC%로 끝났습니다.
pause
exit /b %LAUNCH_RC%
