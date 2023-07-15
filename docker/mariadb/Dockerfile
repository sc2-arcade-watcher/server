# syntax = docker/dockerfile:1.5-labs

FROM mariadb:10.8.8

RUN apt-get update && apt-get install -yq --no-install-recommends \
        mariadb-plugin-provider-lz4 \
        mariadb-plugin-rocksdb

COPY ./conf.d/* /etc/mysql/mariadb.conf.d/
