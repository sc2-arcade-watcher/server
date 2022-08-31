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

RUN <<EOF
    mkdir /app
    chown node:node /app
EOF

ENV YARN_CACHE_FOLDER=/tmp/.yarn_cache

WORKDIR /app

COPY package.json yarn.lock ./

RUN --mount=type=cache,target=/tmp/.yarn_cache <<EOF
    set -eux
    yarn install --pure-lockfile --no-interactive
EOF

COPY . .

RUN <<EOF
    set -eux
    chmod -R a+rx .
    yarn run build
EOF

USER node:node

COPY --from=s2mdec /go/s2mdec/cmd/s2mdec/s2mdec /usr/local/bin/s2mdec

# CMD ["pm2-runtime", "--json", "process.yml"]
CMD ["node", "out/src/bin/datahost.js"]
