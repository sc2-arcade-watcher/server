# syntax = docker/dockerfile:1.4.2-labs

FROM mariadb:10.8.3

RUN <<EOF
    apt-get update
    apt-get install -y mariadb-plugin-provider-lz4 mariadb-plugin-rocksdb
EOF

COPY ./conf.d/* /etc/mariadb/conf.d/
