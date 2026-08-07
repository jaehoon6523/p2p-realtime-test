# Render deploy

Render Root Directory가 `mmo-server`라면 이 폴더의 내용을 저장소 `mmo-server/`에 그대로 넣습니다.

## Environment
BOT_COUNT=3
ROOM_ID=test1

## Build Command
npm install && npm --prefix server-bots install

## Start Command
npm start

정상 로그:
[start-v4] signal=signaling-server.js bots=3
[p2p-arena-signaling] protocol=4 ...
[bot-runner:v4] JOIN phase ...
[bot-runner:v4] joined 3/3
[bot-runner:v4] SETTLE phase
[bot-runner:v4] RUN phase ...

BOT_COUNT=0이면 bot-runner는 실행하지 않습니다.
