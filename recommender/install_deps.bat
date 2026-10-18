@echo off
rem 给计划任务装 Python 依赖。必须由计划任务来跑（schtasks /run /tn AutoredInstallDeps）：
rem 在 Claude 里 pip install 的包会落进 MSIX 虚拟化目录，计划任务看不到。日志在 out\judge\runs\install-deps.log。
cd /d %~dp0
set LOG=out\judge\runs\install-deps.log
echo ==== %date% %time% > %LOG%
python -m pip install --user --disable-pip-version-check -r requirements.txt -r ..\..\requirements.txt >> %LOG% 2>&1
echo EXIT %errorlevel% >> %LOG%
