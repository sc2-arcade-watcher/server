# syntax = docker/dockerfile:1.5-labs

FROM redis:6.2-alpine

COPY ./redis.conf /usr/local/etc/redis/redis.conf

CMD [ "redis-server", "/usr/local/etc/redis/redis.conf" ]
