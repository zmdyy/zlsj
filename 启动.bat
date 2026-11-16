@echo off
cd /d "%~dp0"

set "PYW="
where pythonw >nul 2>&1 && set "PYW=pythonw"
if not defined PYW where python >nul 2>&1 && set "PYW=python"
if not defined PYW (
  echo 未找到 Python，无法写入 data\store.json
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8765); $c.Close(); exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "" /min %PYW% "%~dp0server.py"
  powershell -NoProfile -Command "$ok=$false; foreach($i in 1..40){ try { $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8765); $c.Close(); $ok=$true; break } catch { Start-Sleep -Milliseconds 250 } }; if(-not $ok){ exit 1 }"
  if errorlevel 1 (
    echo 本地保存没有启动成功。
    pause
    exit /b 1
  )
)

start "" http://127.0.0.1:8765/
exit /b 0
