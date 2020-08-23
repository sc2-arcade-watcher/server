# StarCraft II Arcade Watcher

Arcade Watcher collects data from the custom game system of StarCraft II. Its primary focus is to obtain live data about lobbies hosted on the Arcade platform. This data is then made available via WebAPI to develop any sort of external integrations. Such as Discord bots, which notify the players and mod makers about upcoming games.

**Discord bot**

The Arcade Watcher bot, can be added to a Discord's server/guild by using following link: https://discord.com/oauth2/authorize?client_id=672155669633171488&scope=bot&permissions=379968

There's no online documentation, but it also isn't complicated in its usage. Basic instructions and available commands can be retrieved by sending a `.help` command to the bot via DM.

Some extra support can be provided on a SC2Mapster Discord's server: https://discord.gg/bbQ9Jm8

**WebAPI**

Documentation: http://sc2arcade.talv.space/docs/api/

**Website**

https://sc2arcade.talv.space

## How does it work

It uses custom SC2 bots to communicate with Battle.net, through the internal game API. Source code of these bots isn't part of this repository, and I do not plan to disclose it - at least at the time being. The main reason behind it, is to prevent potential abuse. As certain features of the bot could be used to disrupt the Arcade system (bot-hosting lobbies etc.).

The bots are pretty much autonomous - in the sense that they do not require server's government to do their work. Even if connection is lost they'll keep going and buffer collected data, until connection is re-established. All events are tagged with a timestamp, which allows the server to process events in chronological order, as a way to mitigate network latency, and all sort of time specific issues. Which become relevant when there's more than 1 active connection per region at a time.

Even though projects aims to provide live data, in case of failure, it can also retroactively process the journals to fill any missing gaps in the database. This approach in theory helps with reliability of entire project as a source of historical data. It can later be used to build popularity statistics of specific mods, or entire Arcade in a given time frame.

### Limitations of `Battle.net` related code

* List of public lobbies and their corresponding info (number of players etc.) is cached server side. And is refreshed in intervals of 10 sec.
* Details/preview of the lobby (such as list of players and layout of slots) must be requested individually for each lobby. Which wouldn't be a big deal, if not the fact that remote service which deals with these requests is kind of unreliable:
    * Response may sometimes not be provided, even if lobby is still open. Or arrive with considerable delay.
    * If lobby becomes closed no response will be provided either. But we cannot be sure whether lobby was indeed closed until it goes off of the list - the one that is cached..
    * Sending requests in parallel is tricky, because there doesn't seem to be a way to pair the request with response directly. And responses are likely to arrive out of order.
    * Mainaining multiple connections while viable, is somewhat difficult due to another set of issues.
* Due to the above, if there's a lot of lobbies open, the bots can simply have a hard time keeping up.
* Determining outcome of the lobby (`started` / `abandoned`) can be considered reliable only for games with startup delay of 10s. With 7s it's mostly correct. However 5s or less is bound to provide incorrect results every other time.
* Privately hosted lobbies cannot be tracked. It's not even a matter of them being unlisted, but the `RequestPreview` doesn't work on them completely. 
