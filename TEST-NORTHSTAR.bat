@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Northstar Windows validation

set "ROOT=%~dp0"
set "EDITOR=%ROOT%apps\editor"
set "PSD_BRIDGE=%ROOT%packages\psd-bridge"
if defined NORTHSTAR_TEST_LOG (
  set "LOG=%NORTHSTAR_TEST_LOG%"
) else (
  set "LOG=%TEMP%\northstar-test-%RANDOM%-%RANDOM%.log"
)
set "FAILURES=0"
set "CHECKS=0"

pushd "%ROOT%" >nul 2>&1
if errorlevel 1 (
  echo [오류] 프로젝트 폴더를 열 수 없습니다: "%ROOT%"
  pause
  exit /b 1
)

if not exist "%LOG%" (type nul > "%LOG%")
if errorlevel 1 (
  echo [오류] 로그 파일을 만들 수 없습니다: "%LOG%"
  popd
  pause
  exit /b 1
)
>>"%LOG%" echo Northstar Windows validation started %DATE% %TIME%
>>"%LOG%" echo Project: "%ROOT%"

where node >nul 2>&1
if errorlevel 1 goto :node_missing
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22||(major===22&&minor>=6)?0:1)" >nul 2>&1
if errorlevel 1 goto :node_old
where npm >nul 2>&1
if errorlevel 1 goto :npm_missing

echo PSD Bridge와 Editor 의존성 및 빌드를 준비합니다...
pushd "%PSD_BRIDGE%" >nul
if errorlevel 1 goto :psd_directory_error
call npm ls --depth=0 >nul 2>&1
if not errorlevel 1 goto :psd_dependencies_ready
call npm ci >>"%LOG%" 2>&1
set "SETUP_RC=%ERRORLEVEL%"
if "%SETUP_RC%"=="0" goto :psd_dependencies_ready
popd
goto :setup_psd_error
:psd_dependencies_ready
call :begin_check "PSD Bridge build"
call npm run build >>"%LOG%" 2>&1
set "CHECK_RC=%ERRORLEVEL%"
call :report_check "PSD Bridge build"
popd

pushd "%EDITOR%" >nul
if errorlevel 1 goto :editor_directory_error
call npm ls --depth=0 >nul 2>&1
if not errorlevel 1 goto :editor_dependencies_ready
call npm ci >>"%LOG%" 2>&1
set "SETUP_RC=%ERRORLEVEL%"
if "%SETUP_RC%"=="0" goto :editor_dependencies_ready
popd
goto :setup_editor_error
:editor_dependencies_ready
call :begin_check "Editor build"
call npm run build >>"%LOG%" 2>&1
set "CHECK_RC=%ERRORLEVEL%"
call :report_check "Editor build"

call :run_check "Editor typecheck" typecheck
call :run_check "Editor unit tests" test
call :run_check "M1 GUI smoke" smoke:gui
call :run_check "M2 PSD GUI smoke" smoke:psd-gui
call :run_check "M2 AI GUI smoke" smoke:ai-gui
call :run_check "M3 GUI smoke" smoke:m3-gui

popd
popd
echo.
echo Northstar validation summary: %CHECKS% checks, %FAILURES% failed.
echo Full output and results: "%LOG%"
>>"%LOG%" echo.
>>"%LOG%" echo Summary: %CHECKS% checks, %FAILURES% failed.
if "%FAILURES%"=="0" goto :validation_passed
echo Some checks failed. Review the log above for details.
pause
exit /b 1
:validation_passed
echo All validation checks passed.
exit /b 0

:run_check
call :begin_check "%~1"
call npm run %~2 >>"%LOG%" 2>&1
set "CHECK_RC=%ERRORLEVEL%"
call :report_check "%~1"
exit /b 0

:begin_check
set /a CHECKS+=1
echo.
echo [%CHECKS%] Running %~1...
>>"%LOG%" echo.
>>"%LOG%" echo ===== %~1: START =====
exit /b 0

:report_check
if "%CHECK_RC%"=="0" goto :report_check_pass
set /a FAILURES+=1
echo FAIL (exit %CHECK_RC%) - %~1
>>"%LOG%" echo ===== %~1: FAIL (exit %CHECK_RC%) =====
exit /b 0
:report_check_pass
echo PASS - %~1
>>"%LOG%" echo ===== %~1: PASS =====
exit /b 0

:node_missing
>>"%LOG%" echo Prerequisite FAIL: Node.js is missing from PATH.
echo [오류] Node.js가 설치되어 있지 않거나 PATH에서 찾을 수 없습니다.
echo 해결: https://nodejs.org/ 에서 Node.js 22.6 이상을 설치한 뒤 다시 실행하세요.
goto :prerequisite_error
:node_old
>>"%LOG%" echo Prerequisite FAIL: Node.js version is below 22.6.
echo [오류] Node.js 22.6 이상이 필요합니다. 현재 버전:
node --version
echo 해결: Node.js를 22.6 이상으로 업데이트하세요.
goto :prerequisite_error
:npm_missing
>>"%LOG%" echo Prerequisite FAIL: npm is missing from PATH.
echo [오류] npm을 PATH에서 찾을 수 없습니다. Node.js 설치를 확인하세요.
goto :prerequisite_error
:setup_psd_error
>>"%LOG%" echo ===== PSD Bridge dependency install: FAIL (exit %SETUP_RC%) =====
echo [오류] PSD Bridge 의존성 설치에 실패했습니다 (exit %SETUP_RC%). 로그를 확인하세요: "%LOG%"
goto :prerequisite_error
:setup_editor_error
>>"%LOG%" echo ===== Editor dependency install: FAIL (exit %SETUP_RC%) =====
echo [오류] Editor 의존성 설치에 실패했습니다 (exit %SETUP_RC%). 로그를 확인하세요: "%LOG%"
goto :prerequisite_error
:psd_directory_error
>>"%LOG%" echo ===== PSD Bridge directory: FAIL =====
echo [오류] PSD Bridge 폴더를 열 수 없습니다: "%PSD_BRIDGE%"
goto :prerequisite_error
:editor_directory_error
>>"%LOG%" echo ===== Editor directory: FAIL =====
echo [오류] Editor 폴더를 열 수 없습니다: "%EDITOR%"
goto :prerequisite_error
:prerequisite_error
echo 작업 폴더와 npm 출력의 오류를 확인한 뒤 다시 실행하세요.
popd >nul 2>&1
pause
exit /b 1
