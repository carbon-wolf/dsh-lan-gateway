@echo off
chcp 65001 >nul
echo This must run as Administrator.
netsh advfirewall firewall delete rule name="DSH gateway 3080" >nul 2>&1
netsh advfirewall firewall add rule name="DSH gateway 3080" dir=in action=allow protocol=TCP localport=3080 profile=private
echo.
echo Rule added for TCP 3080 on the Private profile.
echo If your phone still cannot connect, allow the same port on the current network profile.
pause
