---
title: 源码运行
---

:::important[使用已发布版本]
请使用已发布版本的代码运行 SQLBot，例如 v1.10.2。不要使用 main 分支。main 分支处于开发阶段，可能存在功能缺陷。
:::

本文以 SQLBot v1.10.2、Ubuntu 24.04 为例，说明如何从源码运行，以及如何在本地构建镜像。示例按 4 核 8 GB 内存准备。

目前支持的源码运行环境有：Windows（x86）、Linux（x86 与 arm64）、macOS（x86 与 arm64）。下文命令以 Linux x86_64 为准。arm64 仅在对应步骤中注明差异。


## 1 项目结构

```
├── backend                                     # 后端 Python 源码
├── docker-compose.yaml                         # docker compose 一键运行文件
├── Dockerfile                                  # 构建容器镜像使用的 Dockerfile
├── frontend                                    # 前端 Vue 源码
├── g2-ssr                                      # MCP 使用到的出图工具
├── installer                                   # 安装工程源码
├── LICENSE                                     # License 声明
├── README.md
├── sqlbot-assistant-demo.html                  # SQLBot 嵌入式小助手示例
└── start.sh
```

## 2 配置环境

### 2.1 安装 Python

SQLBot 要求 Python 3.11（`backend/pyproject.toml` 中为 `==3.11.*`）。Ubuntu 24.04 自带的是 Python 3.12，不能直接用来安装依赖。

```
apt update -y
apt install -y software-properties-common
add-apt-repository -y ppa:deadsnakes/ppa
apt update -y
apt install -y python3.11 python3.11-venv python3.11-dev
```

### 2.2 安装 Git

Ubuntu 24.04 默认已安装 Git。如果环境中没有 Git，执行：

```
apt-get install -y git
```

验证：

```
git --version
```

### 2.3 安装配置 uv

执行官方安装脚本。脚本会安装当前发布的 uv。

```
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env
uv --version
```

### 2.4 安装配置 Node.js

下载 Node.js 22.21.1。版本目录必须写具体版本号。`latest-v22.x` 会随新版本变化，和固定文件名拼在一起后会无法下载。

x86_64：

```
wget https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.gz
tar xvf node-v22.21.1-linux-x64.tar.gz
mv node-v22.21.1-linux-x64 /opt/node-v22.21.1
```

arm64 将文件名和目录名中的 `linux-x64` 改为 `linux-arm64`。

写入环境变量并验证：

```
echo "export PATH=\$PATH:/opt/node-v22.21.1/bin" >> ~/.bashrc
source ~/.bashrc
node --version
npm --version
```

`node --version` 应输出 `v22.21.1`。

### 2.5 安装 Docker

后续的 PostgreSQL 和镜像构建都需要 Docker。已安装可跳过本节。

```
curl -fsSL https://resource.fit2cloud.com/get-docker-linux.sh | bash
systemctl enable docker
systemctl daemon-reload
service docker start
```

### 2.6 安装配置 PostgreSQL

从 v1.1.0 起，SQLBot 使用 PostgreSQL 的向量扩展。下面用带 pgvector 的镜像启动数据库。请在准备存放数据的目录中执行，`./data/postgresql` 相对当前目录。

```
docker run -d \
    --name pg \
    -p 5432:5432 \
    -v ./data/postgresql:/var/lib/postgresql/data \
    -e POSTGRES_DB=sqlbot \
    -e POSTGRES_USER=root \
    -e POSTGRES_PASSWORD=Password123@pg \
    pgvector/pgvector:pg17
```

验证：

```
docker exec pg psql --version
```

SQLBot 进程启动时会自动执行数据库迁移，并执行 `CREATE EXTENSION vector`。数据库镜像需要自带 pgvector，上文使用的 `pgvector/pgvector:pg17` 满足这个条件。


## 3 代码运行

### 3.1 源码准备

克隆已发布标签，并进入项目目录。后续命令都以该目录为起点。

```
git clone -b v1.10.2 https://github.com/dataease/SQLBot.git
cd SQLBot
```

### 3.2 配置运行环境

#### 3.2.1 .env 配置

`.env` 放在项目根目录。从 `backend` 目录启动时，程序读取的是上一级的这个文件。

先生成密钥。不要使用文档、仓库或历史文章中的示例密钥。

```
openssl rand -base64 32
```

在项目根目录创建 `.env`，按实际环境修改。`POSTGRES_*` 必须与第 2.6 节的容器一致。`SERVER_IMAGE_HOST` 中的地址换成运行 MCP 的机器上、调用方能够访问的地址，端口为 8001。

```
PROJECT_NAME="SQLBot"

# Backend
BACKEND_CORS_ORIGINS="http://localhost,http://localhost:5173,https://localhost,https://localhost:5173"
SECRET_KEY=替换为上一步生成的随机字符串

DEFAULT_PWD="SQLBot@123456"

LOG_LEVEL="INFO"  # DEBUG, INFO, WARNING, ERROR
SQL_DEBUG=False

CACHE_TYPE="memory"

# Postgres
POSTGRES_SERVER=localhost
POSTGRES_PORT=5432
POSTGRES_DB=sqlbot
POSTGRES_USER=root
POSTGRES_PASSWORD=Password123@pg

SERVER_IMAGE_HOST=http://服务器IP:8001/images/
```

#### 3.2.2 配置内置向量模型

向量模型目录为 `/opt/sqlbot/models`。程序加载的模型路径是 `/opt/sqlbot/models/embedding/shibing624_text2vec-base-chinese`。

模型来自镜像 `ghcr.io/1panel-dev/maxkb-vector-model:v1.0.1` 中的 `/opt/maxkb/app/model`，与根目录 Dockerfile 的复制路径一致。下面直接从该镜像拷出文件。

```
mkdir -p /opt/sqlbot/models
docker create --name sqlbot-vector-model ghcr.io/1panel-dev/maxkb-vector-model:v1.0.1
docker cp sqlbot-vector-model:/opt/maxkb/app/model/. /opt/sqlbot/models/
docker rm sqlbot-vector-model
```

复制完成后，确认下面的目录存在：

```
ls /opt/sqlbot/models/embedding/shibing624_text2vec-base-chinese
```

Windows 上把同一目录放到项目所在盘的 `\opt\sqlbot\models`，例如 `D:\opt\sqlbot\models`。代码中的默认路径是 `/opt/sqlbot/models`，Windows 会按当前盘符解析。

#### 3.2.3 Oracle Instant Client 安装

只有连接 Oracle 11 或使用 thick 模式时才需要本节。不使用可以跳过。

Ubuntu 24.04 上先安装解压工具和 libaio。该系统提供的是 `libaio1t64`，Instant Client 需要 `libaio.so.1`。

```
apt install -y unzip libaio1t64
ln -sf /usr/lib/x86_64-linux-gnu/libaio.so.1t64 /usr/lib/x86_64-linux-gnu/libaio.so.1
```

arm64 把链接目标改为 `/usr/lib/aarch64-linux-gnu/libaio.so.1t64`。

x86_64 下载并安装客户端：

```
wget https://download.oracle.com/otn_software/linux/instantclient/2326000/instantclient-basic-linux.x64-23.26.0.0.0.zip
unzip instantclient-basic-linux.x64-23.26.0.0.0.zip
mkdir -p /opt/sqlbot/db_client
mv instantclient_23_26 /opt/sqlbot/db_client/oracle_instant_client
```

arm64 使用另一份安装包，解压后的目录名以实际压缩包为准，最终仍要放到 `/opt/sqlbot/db_client/oracle_instant_client`：

```
wget https://download.oracle.com/otn_software/linux/instantclient/2390000/instantclient-basic-linux.arm64-23.9.0.25.07.zip
```

把下面两行加入 `~/.bashrc` 后执行 `source ~/.bashrc`：

```
export ORACLE_HOME=/opt/sqlbot/db_client/oracle_instant_client
export LD_LIBRARY_PATH=$LD_LIBRARY_PATH:$ORACLE_HOME
```

Windows 上将压缩包解压并改名为 `oracle_instant_client`，放到项目所在盘的 `\opt\sqlbot\db_client` 下，例如 `D:\opt\sqlbot\db_client\oracle_instant_client`。


### 3.3 源码编译

在项目根目录执行。前端构建内存占用较高，可用内存建议不少于 4 GB。

```
cd frontend
npm install && npm run build
cd ..
```

后端依赖必须用 Python 3.11 安装。`uv sync` 默认从阿里云 PyPI 镜像拉包，`sqlbot-xpack` 从 TestPyPI 下载。这两处网络不通时命令会失败。

```
cd backend
uv sync --python 3.11 --extra cpu
```

图表服务 g2-ssr 是可选项，供 MCP 出图使用。它依赖 node-canvas，需要先装系统库再安装 Node 依赖。不需要出图可以跳过。

```
apt install -y build-essential python3 pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    libpixman-1-dev libfreetype6-dev
cd ../g2-ssr
npm install
cd ../backend
```


### 3.4 运行

以下命令在 `backend` 目录执行。先创建业务数据目录。`/opt/sqlbot/images` 会在 MCP 启动时自动创建，Excel 与文件目录不会。

```
source .venv/bin/activate
mkdir -p /opt/sqlbot/data/excel /opt/sqlbot/data/file /opt/sqlbot/images
```

启动 g2-ssr（可选）。进程监听 3000 端口，对应配置项 `MCP_IMAGE_HOST` 的默认值 `http://localhost:3000`。

```
nohup node ../g2-ssr/app.js > ../g2-ssr/ssr.log 2>&1 &
```

启动 MCP Server（可选）。进程监听 8001 端口，并通过 `/images` 提供图片。`.env` 里的 `SERVER_IMAGE_HOST` 应指向这个端口。

```
nohup uvicorn main:mcp_app --host 0.0.0.0 --port 8001 > mcp.log 2>&1 &
```

启动 SQLBot：

```
nohup uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1 > sqlbot.log 2>&1 &
```

浏览器访问 `http://服务器IP:8000`。初始用户名为 `admin`，密码为 `.env` 中的 `DEFAULT_PWD`。按上文示例未修改时，密码是 `SQLBot@123456`。启动失败时查看 `backend/sqlbot.log`。


## 4 镜像制作

### 4.1 确认 buildx

第 2.5 节安装的 Docker Engine 已包含 buildx。执行下面的命令，能输出版本号即可。

```
docker buildx version
```

Dockerfile 中有 `FROM --platform=${BUILDPLATFORM}`。该变量由 buildx 注入。使用不带 buildx 的构建器时变量为空，构建会报 `invalid OS component`。

### 4.2 制作镜像

在 SQLBot 项目根目录执行。第 3.4 节的命令停在 `backend` 目录时，先回到上一级。当前目录下需要有 Dockerfile。

x86_64：

```
docker buildx build --platform linux/amd64 -t dataease/sqlbot:v1.10.2 --load .
```

arm64 构建机把 `linux/amd64` 改为 `linux/arm64`。

`--platform` 指定目标系统。`--load` 把结果载入本地镜像列表。不加 `--load` 时，`docker images` 里看不到新镜像。

输出日志参考：

```
docker buildx build --platform linux/amd64 -t dataease/sqlbot:v1.10.2 --load .
[+] Building 522.4s (34/34) FINISHED
 => [internal] load build definition from Dockerfile                                                                                                                                                                           0.1s
 => => transferring dockerfile: 3.47kB                                                                                                                                                                                         0.0s
 => [internal] load metadata for ghcr.io/1panel-dev/maxkb-vector-model:v1.0.1                                                                                                                                                  0.1s
 => [internal] load metadata for registry.cn-qingdao.aliyuncs.com/dataease/sqlbot-python-pg:latest                                                                                                                             0.1s
 => [internal] load metadata for registry.cn-qingdao.aliyuncs.com/dataease/sqlbot-base:latest                                                                                                                                  0.1s
 => [internal] load .dockerignore                                                                                                                                                                                              0.0s
 => => transferring context: 255B                                                                                                                                                                                              0.0s
 => [internal] load build context                                                                                                                                                                                             28.6s
 => => transferring context: 401.15MB                                                                                                                                                                                         28.4s
 => [stage-4  1/10] FROM registry.cn-qingdao.aliyuncs.com/dataease/sqlbot-python-pg:latest@sha256:43e10b22be972d6292c2b0ba3c7ef2a3a1969f1227541d25de935b3f37fa31b7                                                             0.1s
 => => resolve registry.cn-qingdao.aliyuncs.com/dataease/sqlbot-python-pg:latest@sha256:43e10b22be972d6292c2b0ba3c7ef2a3a1969f1227541d25de935b3f37fa31b7                                                                       0.1s
 => [ssr-builder 1/7] FROM registry.cn-qingdao.aliyuncs.com/dataease/sqlbot-base:latest@sha256:5f1602bbb306a4f24fb73797eeaa41f539f6dd236936a896063265a9cd655faf                                                                0.1s
 => => resolve registry.cn-qingdao.aliyuncs.com/dataease/sqlbot-base:latest@sha256:5f1602bbb306a4f24fb73797eeaa41f539f6dd236936a896063265a9cd655faf                                                                            0.1s
 => CACHED [vector-model 1/1] FROM ghcr.io/1panel-dev/maxkb-vector-model:v1.0.1@sha256:da730ff243f5502304c390ec5a52cf79b2b3a0a46e52100e288850dafbf2c8bf                                                                        0.1s
 => => resolve ghcr.io/1panel-dev/maxkb-vector-model:v1.0.1@sha256:da730ff243f5502304c390ec5a52cf79b2b3a0a46e52100e288850dafbf2c8bf                                                                                            0.1s
 => CACHED [sqlbot-ui-builder 2/4] RUN mkdir -p /opt/sqlbot/app /opt/sqlbot/frontend                                                                                                                                           0.0s
 => [sqlbot-ui-builder 3/4] COPY frontend /tmp/frontend                                                                                                                                                                        8.5s
 => [sqlbot-ui-builder 4/4] RUN cd /tmp/frontend && npm install && npm run build && mv dist /opt/sqlbot/frontend/dist                                                                                                        312.3s
 => CACHED [sqlbot-builder 2/7] RUN mkdir -p /opt/sqlbot/app /opt/sqlbot/frontend                                                                                                                                              0.0s
 => CACHED [sqlbot-builder 3/7] WORKDIR /opt/sqlbot/app                                                                                                                                                                        0.0s
 => CACHED [sqlbot-builder 4/7] COPY  --from=sqlbot-ui-builder /opt/sqlbot/frontend /opt/sqlbot/frontend                                                                                                                       0.0s
 => CACHED [sqlbot-builder 5/7] RUN test -f "./uv.lock" &&     --mount=type=cache,target=/root/.cache/uv     --mount=type=bind,source=backend/uv.lock,target=uv.lock     --mount=type=bind,source=backend/pyproject.toml,targ  0.0s
 => [sqlbot-builder 6/7] COPY ./backend /opt/sqlbot/app                                                                                                                                                                        0.3s
 => [sqlbot-builder 7/7] RUN --mount=type=cache,target=/root/.cache/uv     uv sync --extra cpu                                                                                                                                19.6s
 => CACHED [ssr-builder 2/7] WORKDIR /app                                                                                                                                                                                      0.0s
 => CACHED [ssr-builder 3/7] RUN apt-get update && apt-get install -y --no-install-recommends     build-essential python3 pkg-config     libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev     libpixman-1-de  0.0s
 => CACHED [ssr-builder 4/7] RUN npm config set fund false     && npm config set audit false     && npm config set progress false                                                                                              0.0s
 => CACHED [ssr-builder 5/7] COPY g2-ssr/app.js g2-ssr/package.json /app/                                                                                                                                                      0.0s
 => CACHED [ssr-builder 6/7] COPY g2-ssr/charts/* /app/charts/                                                                                                                                                                 0.0s
 => CACHED [ssr-builder 7/7] RUN npm install                                                                                                                                                                                   0.0s
 => CACHED [stage-4  2/10] RUN ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime &&     echo "Asia/Shanghai" > /etc/timezone                                                                                             0.0s
 => CACHED [stage-4  3/10] COPY start.sh /opt/sqlbot/app/start.sh                                                                                                                                                              0.0s
 => CACHED [stage-4  4/10] COPY g2-ssr/*.ttf /usr/share/fonts/truetype/liberation/                                                                                                                                             0.1s
 => [stage-4  5/10] COPY --from=sqlbot-builder /opt/sqlbot /opt/sqlbot                                                                                                                                                        14.1s
 => [stage-4  6/10] COPY --from=ssr-builder /app /opt/sqlbot/g2-ssr                                                                                                                                                            7.4s
 => [stage-4  7/10] COPY g2-ssr/supervisord.conf /etc/supervisor/conf.d/g2-ssr.conf                                                                                                                                            0.2s
 => [stage-4  8/10] COPY --from=vector-model /opt/maxkb/app/model /opt/sqlbot/models                                                                                                                                           3.9s
 => [stage-4  9/10] WORKDIR /opt/sqlbot/app                                                                                                                                                                                    0.1s
 => [stage-4 10/10] RUN mkdir -p /opt/sqlbot/images /opt/sqlbot/g2-ssr/logs                                                                                                                                                    0.4s
 => exporting to image                                                                                                                                                                                                       117.2s
 => => exporting layers                                                                                                                                                                                                       88.7s
 => => exporting manifest sha256:cfab18701f6878220adf1c8e027cc2b76bef8a3fd4b21757d496fbe59dc62bb3                                                                                                                              0.0s
 => => exporting config sha256:7bc54038fdfa9b43d7fcff94635962d26dfdd302868850910cdb0789bae28b08                                                                                                                                0.0s
 => => exporting attestation manifest sha256:f7d5b6fac96122ab8605df24d6d60fc82cd11a9ee26c037f901085aae3e5e5fe                                                                                                                  0.0s
 => => exporting manifest list sha256:b17016e321500203dc8d95d351a5c7ecece49d7bb0c29e22d3fb9646d4a8b5a5                                                                                                                         0.0s
 => => naming to docker.io/dataease/sqlbot:v1.10.2                                                                                                                                                                             0.0s
 => => unpacking to docker.io/dataease/sqlbot:v1.10.2                                                                                                                                                                         28.3s

 1 warning found (use docker --debug to expand):
 - SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data (ENV "POSTGRES_PASSWORD") (line 81)
```

日志末尾的 `SecretsUsedInArgOrEnv` 提示的是 Dockerfile 中的 `POSTGRES_PASSWORD`，不影响本地镜像生成。

用 `docker images` 查看镜像是否已在本地：

```
docker images
REPOSITORY        TAG       IMAGE ID       CREATED         SIZE
dataease/sqlbot   v1.10.2   b17016e32150   4 minutes ago   6.78GB
```
