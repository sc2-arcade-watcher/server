This API is provided free of charge for non profit use.

Anyone with intentions to utilize it to build something for a wider audience should first seek approval.

### Rate limiting

Current limits are: up to 500 requests in the span of 5 minutes. This only applies to requests which aren't cached on the HTTP layer. (Currently it means every request counts because I haven't yet configured varnish, lol).

If the limit is exceeded `429` HTTP response will be given, instead of the requested one.

### Pagination

Some of the endpoints are paginated. If that is the case the result of a request will be similar to the following:

`$ http http://sc2arcade.talv.space/api/lobbies/history/map/1/208271 | jq --indent 4 | head -n 10`
```js
{
    "count": 483526,
    "next": "limit=50&offset=50",
    "previous": null,
    "results": [
        {
            "bnetBucketId": 1574794309,
            "bnetRecordId": 10014470,
            "closedAt": "2020-01-20T05:51:30.000Z"
        },
        // ... 49 more items
    ]
}
```

To retrieve remaining results you need to pass `limit` and `offset` parameters in a GET query. To navigate to the next page in above example the correct URL would be `http://sc2arcade.talv.space/api/lobbies/history/map/1/208271?limit=50&offset=50` etc.

Default `limit` for pagination is `50` results, but it can be increased up to `500`.

---

> <s>See it on GitHub: [SC2-Arcade-Watcher](https://github.com/SC2-Arcade-Watcher)</s> *soon (tm)*
