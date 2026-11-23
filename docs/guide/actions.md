# Actions

[The guide](README.md)

An **action** is a launch configuration made into a short form for people who run things but do
not read flows: a manager restarting a switch, a service desk resetting a port. They see a title,
a sentence on what it does, only the values they choose, a summary of what will happen, and
**Run**. No canvas, no code, no commit or inventory. While it runs they follow it in plain words.

## Make a launch configuration an action

On the configuration's page, **Settings**, section **Action**, **Make it an action** (an
administrator, or someone with **read and write** on the workspace):

- **Title** and **What it does**: in the runners' words ("Restart the edge switch", "Restarts one
  edge switch and checks it answers again").
- **What it asks**: tick the inputs a runner chooses, each with a **label** ("Switch", not
  `devices`) and a **help line**. **Choices** (names separated by commas) limit it to those values;
  a host list without choices offers the inventory's hosts and groups by name; **Only hosts of
  group** narrows it to one inventory group (its hosts and its child groups' hosts are offered, no
  other name is taken). Every input not
  ticked runs with the configuration's value, and a runner cannot change it: the server refuses a
  value for an input the action does not ask. Secret-looking inputs are never asked: give them
  with a credential.
- **It runs** as a check or for real: the action decides, not the runner.
- **Run asks to confirm first**: the runner sees what they chose and answers **Run** or **Not
  now**.
- **A link that gives every value runs as it opens**: see
  [Links from NetBox and Zabbix](#links-from-netbox-and-zabbix). Off by default.
- **Result back**: whom a run started from a link tells how it ended (see below).
- **On**: off, nobody can run it; its words and who may run it are kept for when it is on again.
  **Stop being an action** forgets both; the configuration stays.

Whoever saves it last is the action's **owner**: runners are told to ask them (and the server's
administrators) when something goes wrong.

## Who may run it

Under the action, **Who may run it**: a person by login or a group by name, then **Let them run
it**. That grant gives the action and nothing else of the workspace: no flows, files,
configurations, runs or search results, not even the workspace's name in the menu. **Take back**
ends it at once. Operators of the flow and administrators may run it without a grant. The
workspace's **Access** tab lists every action of the workspace and who may run it, and its
**Who can do what** has an Actions column; a person's **What they reach** lists theirs.

Someone with read and write on the workspace gives the action to people and groups who already
have access to this workspace (a grant on it, on one of its flows, or on one of its actions,
their own or a group's): the login box offers them. Anyone else, and a login or group that does
not exist, gets the same answer ("No person … with access to this workspace"), so the form does
not tell which logins the server has. An administrator gives it to anyone, for example someone's
first action.

Deleting the launch configuration ends the action and every grant of it: the question before it
names the action, who can no longer run it and a run of it that still goes or is paused, and the
[audit log](audit.md) records the action and each grant as ended, with why. Deleting a person or
a group records the action grants that end with them the same way.

An action never runs step by step: its runs go from start to end (a step-by-step run of the
same configuration, launched from its **Launch** tab, says "Paused before ..." in this view too).

Approvals in the flow still apply: the run waits at an approval step until someone allowed
decides, as for every run. The runner does not decide (unless the workspace lets whoever launched
a run decide, see [Approvals](approvals.md)).

## Running one

**Actions** in the side menu lists the actions you may run, each with your last run of it. Someone
whose only access is actions lands on Actions when they sign in, and the menu holds only Actions
and Help.

An action opens its form: the values it asks, **What will happen** (check or real, the steps it
goes through by title, the approvals it waits at and who decides them; the values the action keeps
fixed are not listed: whoever set it up answers for them), and **Run**. A value that is missing or not one of the choices is said at its field.

![An action's form on a phone](images/action-form.png)

## How it goes

After **Run** the page shows the run's progress, live, at its own address
(`/actions/runs/<run>`). It opens for whoever started the run, and for whoever may see the flow's
runs (read only or more on the flow); someone who may only run the action does not see runs that
others started:

- where it is in one sentence: waiting to start, running step 2 of 3, waiting for approval at
  _Approve the change_ by _change-board_, done, failed;
- the steps by title, each done, running, waiting, failed or to do, and how many of how many are
  done;
- when it failed, why in words (which step, how many hosts, or who rejected it and their comment)
  and whom to ask: the action's owner, then the administrators;
- the values it was asked for, by their labels.

Who may see the run itself (read only on the flow) also gets **The full run page**, with the
canvas and the output. **Run it again** opens the form again once the run ended.

![A run of an action, step by step](images/action-progress.png)

## Links from NetBox and Zabbix

A link opens an action with values from the object it is on:
`https://<server>/a/<action id>?<input>=<value>&…`. Each query name is an input the action asks
(its name, as **It asks** shows in brackets).

- When the link gives every value the action asks and they are right (as the form checks them:
  the choices, the type, the group), the page lists them by label with **What will happen**, and
  **Run** (or **Change the values**, or **Not now**).
- When some are missing or not right, the action's short form opens with the link's values in:
  what the link gave is listed under **From the link**, and only the rest is asked.
- A name the action does not ask is refused in plain words: the link is wrong, ask whoever made
  it.
- Opening a link never runs anything: **Run** does, from the page. With **A link that gives every
  value runs as it opens**, the page itself starts the run as it opens, once, and the progress
  says the link started it.
- Not signed in: the sign-in page opens at the link, and after signing in (password, directory or
  your organisation's sign-in) you are back on it. Your own access decides: you may run the
  action, or are an operator of its flow, or an administrator.

### Make the link: Copy link for NetBox / Zabbix

On the configuration's **Settings**, under the action, **Links from NetBox and Zabbix**: pick
NetBox or Zabbix, then for each input where its value comes from (a device's name, its primary
IPv4 address, its site; a Zabbix host's name, IP, or what the person types), or leave it out (the
person fills it in). The page gives the link, and what to paste in NetBox or Zabbix. The server's
address in it is the address you have the page open at.

**NetBox** (checked with NetBox 4.7):

1. **Customization › Custom Links › Add**: **Name** and **Link text** (the action's title),
   **Object types** _DCIM › Device_, **Link URL** the link from **Copy link** (Jinja on `object`,
   for example `{{ object.name|string|urlencode }}`), **Button class** _Blue_, **Group name**
   _Ansible Flow Server_ (links of one group become a dropdown), **New window** ticked. Save.
   Or `POST /api/extras/custom-links/` with the JSON the page gives and a NetBox API token.
2. A device's page now has the button. A device without a primary address gives an empty value:
   the form asks for it.

**Zabbix** (checked with Zabbix 8.0):

1. **Alerts › Scripts › Create script**: **Scope** _Manual host action_ (a host's menu) or
   _Manual event action_ (a problem's menu), **Menu path** _Ansible Flow Server_, **Type** _URL_,
   **URL** the link from **Copy link** with macros (`{HOST.HOST}`, `{HOST.IP}`, `{EVENT.ID}`),
   **Open in a new window** ticked. Optionally **Advanced configuration › Enable user input** to
   ask the person a value (`{MANUALINPUT}`). Save. Or call `script.create` with the JSON the page
   gives (type 6, scope 2 or 4) and a Zabbix API token.
2. The host's or problem's menu now has the item under _Ansible Flow Server_.

To point existing links at another server (or another action), change the address (and the id
after `/a/`) in the custom link's **Link URL**, or the script's **URL**.

### The result back

**Result back** on the action's settings: **Tell** NetBox or Zabbix, **with the credential** (a
credential of the workspace of kind **NetBox token** or **Zabbix token**: the system's address,
`https://netbox.example.net`, and an API token), **when** every run ends, or only when it did not
go well. A run started from a link that says where it came from then writes, in plain words with
the link to its progress:

- in NetBox, a **journal entry** on the object (success, danger or warning). The link carries the
  object as `_reply=dcim.device:{{ object.id }}` (Copy link adds it). The token needs permission to
  add journal entries.
- in Zabbix, a **message on the problem** (as an acknowledgement's message, without closing it).
  The link carries the problem as `_reply=event:{EVENT.ID}` (Copy link adds it for a problem's
  menu). The token's user needs to acknowledge problems of the host.

The messages go through the server's notification outbox: tried again when the system cannot be
reached, and listed on **Notifications** (to whom: the object). Links in them need
`AFS_PUBLIC_URL`.

### Signed links, for systems with no person

A Zabbix action on a trigger, or a NetBox webhook, starts a run with no person to sign in. Under
**Signed links**, give it a name and **Make a signed link** (in a session on the pages, by who may
change the action). The token is shown once: keep it in the system that uses it. It runs this
action only, as you, with the inputs it asks:

```
curl -X POST https://<server>/api/v1/actions/<action id>/run \
  -H 'Authorization: Bearer afsl_…' -H 'Content-Type: application/json' \
  -d '{"inputs": {"device": "{HOST.HOST}"}, "reply": "event:{EVENT.ID}"}'
```

It is taken only in the `Authorization` header of that POST: never in a link, and no other address
answers to it. Every run with it is in the audit log (yours, with the token's name). **Revoke**
stops it at once; so do stopping the action and your account going.

## The API

| Route                                                                   | What                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/v1/actions`                                                   | The actions you may run, each with your last run      |
| `GET /api/v1/actions/<id>`                                              | Its form: the asked inputs, what will happen          |
| `GET /api/v1/actions/<id>/hosts`                                        | The inventory's hosts and groups for a host list      |
| `GET /api/v1/actions/<id>/link?<input>=<value>`                         | What a link gives: ready to confirm, or what is left  |
| `POST /api/v1/actions/<id>/run`                                         | `{"inputs": {"devices": "sw-edge-02"}}`: run it       |
| `GET /api/v1/actions/runs/<run>` (and `/events`, live)                  | How a run of it goes, in words                        |
| `GET`, `PUT`, `DELETE /api/v1/launch-configs/<id>/action`               | The action of a configuration: read, set, stop        |
| `POST /api/v1/launch-configs/<id>/action/grants`, `DELETE …/<g>`        | Who may run it: `{"user": "mia"}` or `{"group": "…"}` |
| `GET /api/v1/workspaces/<id>/actions`                                   | Every action of a workspace, with who may run it      |
| `GET`, `POST /api/v1/launch-configs/<id>/action/tokens`, `DELETE …/<t>` | Signed links: list, make (`{"name": "…"}`), revoke    |

An action's id is its launch configuration's id. Setting, granting, taking back and running are in
the [audit log](audit.md) (`action.set`, `action.remove`, `action.grant`, `action.grant-remove`,
`action.run`, and for signed links `action.link-create`, `action.link-revoke`; a run from a link
says `via: link` or `via: signed link`).
