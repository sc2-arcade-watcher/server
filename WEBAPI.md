This API is provided free of charge for non profit use.

Anyone with intentions to utilize it to build something for a wider audience should first seek approval.

### Rate limiting

Current limits are: up to 100 requests in the span of 40 seconds.

If the limit is exceeded `429` HTTP response will be given, instead of what was requested.

Certain (unoptimized) endpoints might use harsher limits on amount of requests, but with lower reset window. An example of this is `/lobbies/active`.

### Pagination

Some of the endpoints are paginated. Depending on the endpoint it might be either cursor based pagination (for big data sets), or *classic* offset based pagination (currently not in use anywhere).

#### Cursor based pagination

Example:

`http://sc2arcade.talv.space/api/maps?limit=100&orderBy=versionId&orderDirection=asc`
```js
{
    "page": {
        "prev": null,
        "next": "WzUzXQ=="
    },
    "results": [
        {
            "id": 1,
            "regionId": 1,
            "bnetId": 6,
            "type": "dependency_mod",
            "iconHash": "9df061a77575e35fb015fbdf43ce201d3ba313e1d4738e1410a9832b773a5f8f",
            "name": "Teams 04 (Mod)",
            "description": "Teams 04 (Mod)",
            "website": null,
            "mainCategoryId": 1,
            "maxPlayers": 16,
            "updatedAt": "2020-07-27T18:11:04.000Z",
            "publishedAt": null,
            "currentVersion": {
                "id": 1,
                "majorVersion": 1,
                "minorVersion": 25,
                "isPrivate": false
            }
        },
        // ... 49 more records
    ]
}
```

Cursor pointer for the previous & next page is provided in:
```js
"page": {
    "prev": null,
    "next": "WzUzXQ=="
},
```

If `prev` is `null`, it means we are at the begining of data set, and there's nothing to go back to. If `next` is `null` it means we've reached an end of data set. And there are no more records available at this time. 

The pointer passed in `next`/`prev` will remain valid. What allows us to resume retrieval process from the same exact point we've stopped - skiping everything we've received previously. When requested sorting method uses incremental primary key of a table (such as `id`), in `ASC` order, it is guaranteed that any new records will only appear after. While this cannot be guaranteed for `updated` and `published` timestamps of maps uploaded to Arcade, since the service retrieves them out of order.

To navigate to the next page in example shown above, the correct URL would be `http://sc2arcade.talv.space/api/maps?limit=100&orderBy=versionId&orderDirection=asc&after=WzUzXQ==` etc.

Which now also returns pointer to the previous page:
```js
{
    "page": {
        "prev": "WzU0XQ==",
        "next": "WzEzNV0="
    },
}
```

If we wanted to go back, the correct URL would be `http://sc2arcade.talv.space/api/maps?limit=100&orderBy=versionId&orderDirection=asc&before=WzU0XQ==`

etc.

* Default `limit` of returned records per page is `50`, but it can be increased up to `500`.

### Other

- Timestamps are in UTC, given in ISO format with precision up to 3 decimal places.
- For everything else not covered by the docs above, [consult the source code](https://github.com/sc2-arcade-watcher/server/tree/master/src/api).

---

> See it on GitHub: [SC2-Arcade-Watcher](https://github.com/SC2-Arcade-Watcher)
