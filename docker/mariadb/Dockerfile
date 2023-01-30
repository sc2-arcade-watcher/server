# syntax = docker/dockerfile:1.4.2-labs

FROM mariadb:10.8.3

RUN <<EOF
    set -eu
    apt-get update
    apt-get install -yq --no-install-recommends mariadb-plugin-provider-lz4 mariadb-plugin-rocksdb
EOF

COPY ./conf.d/* /etc/mysql/mariadb.conf.d/
