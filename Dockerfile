# syntax = docker/dockerfile:1.4.2-labs

FROM golang:1.18-alpine as s2mdec

RUN --mount=type=cache,target=/var/cache/apk \
    apk add --update \
        git \
        make

RUN <<EOF
    git clone https://github.com/sc2-arcade-watcher/s2mdec.git
    cd s2mdec/cmd/s2mdec
    go build -i -v -ldflags "-w -s" -o s2mdec .
EOF


FROM node:16-alpine as app-dev

RUN --mount=type=cache,target=/var/cache/apk \
    apk add --update \
        fd \
        ripgrep \
        wget \
        curl \
        imagemagick \
        inotify-tools \
        coreutils \
        patch \
        bash \
        zstd \
        supercronic

WORKDIR /app
RUN chown node:node /app
USER node

COPY --from=s2mdec --link /go/s2mdec/cmd/s2mdec/s2mdec /usr/local/bin/s2mdec

CMD ["node"]


FROM app-dev as app-prod

COPY --chown=node:node package.json yarn.lock ./

RUN --mount=type=cache,target=/tmp/.yarn_cache,uid=1000 \
    YARN_CACHE_FOLDER=/tmp/.yarn_cache yarn install --pure-lockfile --no-interactive

COPY --chown=node:node . .

RUN yarn run patch-modules && yarn run build
