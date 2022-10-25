# syntax = docker/dockerfile:1.4.2-labs

FROM golang:1.18-alpine as s2mdec

RUN <<EOF
    set -eux
    apk add --no-cache \
        git \
        make
    git clone https://github.com/sc2-arcade-watcher/s2mdec.git
    cd s2mdec/cmd/s2mdec
    make
    # go build -i -v -ldflags "-w -s"
EOF


FROM node:16-alpine

RUN <<EOF
    set -eux
    apk add --no-cache \
        fd \
        ripgrep \
        wget \
        curl \
        imagemagick \
        inotify-tools \
        coreutils \
        bash
EOF

WORKDIR /app

RUN chown node:node /app

COPY package.json yarn.lock ./

RUN --mount=type=cache,target=/tmp/.yarn_cache \
    YARN_CACHE_FOLDER=/tmp/.yarn_cache yarn install --pure-lockfile --no-interactive

COPY . .

RUN yarn run build

COPY --from=s2mdec /go/s2mdec/cmd/s2mdec/s2mdec /usr/local/bin/s2mdec

USER node:node

# CMD ["pm2-runtime", "--json", "process.yml"]
CMD ["node"]
