@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Northstar Editor

set "ROOT=%~dp0"
set "EDITOR=%ROOT%apps\editor"
set "PSD_BRIDGE=%ROOT%packages\psd-bridge"

pushd "%ROOT%" >nul 2>&1
if errorlevel 1 goto :root_error

rem Prefer an already packaged application when one is present.
if exist "%EDITOR%\release\" (
  for /r "%EDITOR%\release" %%F in ("Northstar Editor.exe") do if not defined PACKAGED_EXE if exist "%%~fF" set "PACKAGED_EXE=%%~fF"
)
if defined PACKAGED_EXE goto :run_packaged

where node >nul 2>&1
if errorlevel 1 goto :node_missing
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22||(major===22&&minor>=6)?0:1)" >nul 2>&1
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

:run_packaged
echo 기존 패키지를 실행합니다: "%PACKAGED_EXE%"
rem Wait for the GUI process so a launch/crash exit code is not discarded.
start /wait "Northstar Editor" "%PACKAGED_EXE%"
set "LAUNCH_RC=%ERRORLEVEL%"
if not "%LAUNCH_RC%"=="0" goto :packaged_launch_error
popd
exit /b 0

:root_error
echo [오류] 프로젝트 폴더를 열 수 없습니다.
echo 해결: RUN-NORTHSTAR.bat를 프로젝트 루트에 두고 다시 실행하세요.
goto :failed_without_popd

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
goto :failed

:packaged_launch_error
echo [오류] 패키지 Editor가 종료 코드 %LAUNCH_RC%로 끝났습니다.
echo 해결: 앱 실행 권한과 Windows 보안 정책을 확인하고 패키지를 다시 빌드하세요.
goto :failed

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
