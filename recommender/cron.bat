@echo off
rem 定时跑推荐层：小模型打分 → 老师补标 → 同步 AI 判断 → 改写精选 → 出每日清单。日志在 out\judge\runs\cron.log。
rem 打分交给本地小模型（scripts\student.py，只用 CPU）：Harrier 270M 的结果进 MyHOT，0.6B 只在后台攒数据做对比。
rem 老师（judge.py 的 LLM，默认 Gemini 3.8 Flash）每天只标一次、20 篇小模型最拿不准的新文章。
cd /d %~dp0
set PYTHONIOENCODING=utf-8
set HF_HUB_OFFLINE=1
set TAG=student-harrier-oss-v1-270m
echo ==== %date% %time% >> out\judge\runs\cron.log
python scripts\student.py run >> out\judge\runs\cron.log 2>&1
python scripts\student.py teach >> out\judge\runs\cron.log 2>&1
python scripts\judge.py --tag %TAG% sync --days 30 >> out\judge\runs\cron.log 2>&1
python scripts\judge.py --tag %TAG% select --days 30 >> out\judge\runs\cron.log 2>&1
python scripts\judge.py --tag %TAG% daily --days 7 >> out\judge\runs\cron.log 2>&1
