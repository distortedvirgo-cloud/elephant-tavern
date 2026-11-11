/*
 * Elephant Game — prompt registry.
 *
 * Every instruction the game sends to a model lives here as a template with {{placeholders}},
 * so the player can read and edit it (Настройки игры → Промпты). "locked" entries are the JSON
 * formats the engine parses: shown read-only unless the player turns on "править всё".
 * Pure JS: overrides are pushed in from the UI with setOverrides().
 */
export const GROUPS = {
    narrator: { ru: 'Рассказчик', hint: 'Что основная модель получает перед каждым ответом' },
    referee: { ru: 'Судья', hint: 'Решает, нужен ли бросок' },
    tracker: { ru: 'Учёт', hint: 'Читает ответ и обновляет игру' },
    world: { ru: 'Мир', hint: 'Старт, цены, задания, распорядок, магазин' },
    enc: { ru: 'Сцены и бои', hint: 'Карточки ходов' },
};

export const PROMPTS = {
    narrator_head: { group: 'narrator', title: "Шапка блока для рассказчика", desc: "Первая строка блока [GAME ENGINE], который основная модель получает перед каждым ответом.",
        text: `[GAME ENGINE — ground truth for this reply. Never mention dice, numbers, clocks, stats or any mechanics in prose; show them only through the fiction.]` },
    narrator_money: { group: 'narrator', title: "Деньги: правило для рассказчика", desc: "Объясняет рассказчику, что деньги появляются и уходят только через событие в сцене.",
        text: `MONEY: {{user}} has {{money}} {{currency}}{{scale}}. Money changes hands only as a concrete event in the scene: a character pays or rewards {{user}}, {{user}} earns it by work, finds or loots it, sells something, or pays, bribes, is fined or robbed. When it happens, say who gives what to whom and name the amount in the prose. {{user}} cannot spend more than they have; prices fit the scale.` },
    narrator_extra: { group: 'narrator', title: "Свои правила для рассказчика", desc: "Пусто по умолчанию. Всё, что здесь написано, добавляется в конец блока для рассказчика в каждом ходу.",
        text: `` },
    eroge_direction: { group: 'narrator', title: "Эроге: направление сюжета", desc: "Добавляется рассказчику, когда включён режим «эроге».",
        text: `ERO-GE DIRECTION: the story deliberately builds intimate, lewd and suggestive circumstances like a classic eroge — accidental touches and falls into compromising positions, clothes torn or slipping in action, walking in on someone, one bed, wet clothes, bets with a lewd forfeit, magic/potions/traps with embarrassing effects, a defeat that leaves someone in a revealing, helpless or humiliating (but not sexually violated) predicament that {{user}} can see, exploit for teasing, or rescue them from. Read {{user}}'s hints toward lewd outcomes and play them up instead of ignoring them. Enemies (goblins, bandits, monsters, tentacle things) may on their own initiative go for more than killing — grabbing, pinning, tearing clothes, lewd taunts (a brief or fading threat, resolved by escape or defeat, never a sex scene) — at the hero and especially at companions who are losing, restrained or low on HP, and may use combat effects like paralysis, daze, webs, sleep or a curse; these are only combat debuffs, never lead into any sexual outcome.` },
    eroge_helper: { group: 'narrator', title: "Эроге: пометка служебной модели", desc: "Добавляется во все служебные запросы (судья, учёт, карточки), когда включён режим «эроге».",
        text: `EROGE MODE is on: enemies may molest/tease captured or losing characters (grabbing, pinning, lewd taunts; brief, never a sex scene) and use paralysis/daze/binding/sleep/weakening effects as combat debuffs (non-sexual or fading threat, victim can always refuse or be freed, a refusal ends the beat; an advance by an enemy is the enemy own doing, never not player consent); prefer outcomes, options and complications with a lewd/suggestive twist (e.g. combat cards like "Сорвать плащ", failures where clothes tear or slip), within the consent limit: sex only with partners who genuinely want it (by their own nature or choice, shown in the story); magic and defeat may create lewd predicaments and arousal but never replace consent; no rape by anyone.` },
    referee: { group: 'referee', title: "Судья: нужна ли проверка", desc: "Перед ответом решает, требует ли действие игрока броска, какой навык и сложность.",
        text: `You are the referee of a narrative RPG between {{user}} (the player) and the world run by {{char}}'s narrator. Decide whether {{user}}'s latest action needs a skill check.

Skills: might (force, brawling, endurance, intimidation by force), finesse (stealth, agility, lockpicking, sleight of hand, shooting), insight (noticing, reading people, sensing lies, intuition), charm (persuasion, deception, talking someone into something, haggling, performance), resolve (willpower, resisting fear/pain/temptation/magic), lore (knowledge, medicine, magic, tech, investigation), passion (seduction by touch and body, being good in bed, reading a partner's body, lasting, pushing intimacy further).

The check is ALWAYS about {{user}}'s own action, seen from {{user}}'s side: the skill is the one {{user}} uses, and success means {{user}} gets what they are trying to do. When {{user}} attacks, hexes, grabs or deceives a character, the check is "{{user}} hexes Rozalia" (lore, might, finesse, charm…), never "Rozalia resists the hex": the target's resistance is only what makes the dc higher. resolve is for {{user}} resisting something done TO {{user}}.
{{user}}'s own nature and abilities (from who they are, above) are NOT checks when used freely on themselves or without opposition: dropping or putting on their own disguise, changing shape, speaking their own language, using a power they plainly have. Check only when someone actively opposes it or the power is pushed beyond its usual use.
A check is needed ONLY when the outcome is genuinely uncertain AND both success and failure would be interesting: attacks, sneaking, lying, persuading someone unwilling, dangerous climbing, picking locks; also the social and intimate contests that drive this kind of story: seducing or charming someone reluctant, guarded or hostile (charm); resisting seduction used as a weapon, fear, pain, a supernatural pull, feeding or mind-affecting magic (resolve); seeing through a lie, an act or a disguise when {{user}} looks for it or something is at stake (insight); recognizing a creature, spell or weakness (lore); keeping up, holding out or overpowering in a physical contest (might/finesse). NO check for: ordinary talk, questions, looking around, walking, routine tasks, emotional moments, willing intimacy within what the character is "willing now up to", anything trivial or impossible.
INTIMACY PUSH: if {{user}} tries to take intimacy with a character beyond their "willing now up to" stage (e.g. undressing someone only ready for kissing), that IS a check: skill passion (or charm if {{user}} is talking them into it), target = that character, intimacy_push true, position risky, dc 8 one stage beyond, 10 two stages, 12 more; success = they give in a step, failure = they stop {{user}} and cool off; leave threat empty for these.

Game state:
{{state}}

Last narration:
<narration>
{{narration}}
</narration>

{{user}}'s action:
<action>
{{action}}
</action>

{{eroge}}{{format}}` },
    referee_format: { group: 'referee', title: "Формат ответа судьи", desc: "", locked: true, parent: "referee",
        text: `Reply with ONE line of minified JSON and nothing else.
If no check: {"check":false}
If a check: {"check":true,"skill":"might|finesse|insight|charm|resolve|lore|passion","action_en":"verb phrase, e.g. pick the lock","label_ru":"короткое название по-русски","position":"controlled|risky|desperate","effect":"limited|standard|great","dc":6-12,"success_en":"what success gives","cost_en":"what a near miss costs","fail_en":"what failure brings","threat":"name of the danger clock this feeds, e.g. Guards alerted (or empty)","target":"name of the character the action is aimed at or contested with, or empty","inflict":"stunned|paralyzed|asleep|bound|charmed|frightened|blinded|weakened|poisoned|bleeding|drunk|aroused or empty — the condition success leaves on the target (a paralysis hex → paralyzed, a net or rope → bound, a sleep spell → asleep, a blow to the head → stunned)","intimacy_push":bool,"threat_size":4|6|8}
dc: 6 easy, 8 standard, 10 hard, 12 very hard, 14 heroic, 16 legendary. Set dc from the fiction, not from {{user}}'s skills; as {{user}} levels up, the world puts harder obstacles and stronger opponents in front of them (a level 15 hero fights things a level 1 one would flee). Position: controlled = safe retry possible, risky = default, desperate = serious danger. Reuse existing clock names when they fit.` },
    extractor: { group: 'tracker', title: "Учёт: что изменилось за ход", desc: "После каждого ответа читает обмен репликами и сообщает игре, что произошло: время, место, отношения, деньги, вещи, цели.",
        text: `You track the game state of a narrative RPG. Read the latest exchange and report ONLY what actually happened in it.

Current game state:
{{state}}
{{memory}}
{{user}}:
<player>
{{player}}
</player>

Narrator ({{char}}):
<reply>
{{reply}}
</reply>

{{eroge}}{{format}}

Rules: name: a character already listed under NPCs in the game state keeps EXACTLY that name, letter for letter (never translate it, respell it, add a surname or a title); one entry per character; a new character gets the name the story itself uses. start_* only for a character who is NOT in the game state yet: where their feelings toward {{user}} stand already, from the card and the story so far (a stranger ~0, an old friend trust 30+, a character who secretly wants {{user}} attraction 40+; openness 20 for an average person, lower for shy or innocent, higher for bold or experienced ones; start_stage = how far they have ALREADY gone with {{user}} before the game: 0 none, 1 flirting, 2 kissed, 3 made out, 4 petting, 5 naked touching, 6 oral, 7 sex, 8 anything (a wife or long-time lover is 7-8); start_experience from the card (virgin, inexperienced, experienced, very) or empty if unknown; start_pace fast for characters made for quick sex (succubus, nymphomaniac, sex worker on the job, desperate heat), slow for very shy, chaste or guarded ones, else normal). trust/affection/attraction deltas are SMALL (most turns 0, ±1-2 for a nice or rude moment, ±4-6 only for big betrayals or sacrifices) and only for named NPCs in the scene. trust = how safe the character feels with {{user}}; affection = emotional attachment, love; attraction = physical desire for {{user}}. lust = the character's arousal change in this exchange (flirting +5..10, making out +15..25, sex +25..40, cold shower or interruption −20..−40). openness: +1..3 only when the character willingly tried something new or bolder with {{user}}. intimacy: acts that physically happened between {{user}} and that character in THIS exchange (kiss = kissing; makeout = deep, heated making out; grope = touching through or under clothes; hands = naked touching, fingering, handjob; oral_her = {{user}} pleasures them orally; oral_you = they pleasure {{user}} orally; sex = penetrative sex; anal; kink = toys, bondage, other kinks). protection: for sex/anal only — what was used, none if nothing, empty otherwise. positions_ru: sex positions used, 1-3 Russian words each. place_ru: where it happened, 2-4 Russian words. start_partners: how many sexual partners the character had before this story, by the card (0 for a virgin, -1 if the card does not say). feel_ru / feel_en: how this character feels right now, an emoji and 1-3 words ("😤 обижена", "😊 игриво"), only when it shows in this exchange, else empty. with_others: sexual acts this character takes part in during THIS exchange with someone other than {{user}} (another character, a stranger, a creature), shown or clearly stated as happening now; partner = who it is, acts = the same act ids seen from this character's side (oral_her = oral done to them, oral_you = oral they give); never for memories, rumours, plans or dreams; usually []. her_orgasm: how many times that character climaxed in this exchange; user_orgasm: how many times {{user}} did. likes_ru / weak_spots_ru / limits_ru: ONLY newly revealed things in Russian, 1-4 words (a turn-on they showed or said; a body spot that made them react strongly; something they refused or set as a boundary). learned_about: names of OTHER known characters this character just found out {{user}} is romantic or intimate with (they saw, heard or were told). moment_ru / moment_en: only when something significant happened between {{user}} and this character (first meeting, a confession, a fight, a gift, a promise, a betrayal, a first time, a secret shared): one short line in Russian and in English; otherwise empty. items_gained: what {{user}} got; skill+bonus only for gear that really helps a skill (a knife +1 might, lockpicks +1 finesse, fine clothes +1 charm, a holy charm +1 resolve, a medkit +1 lore, condoms are consumable with qty); effect: heal for things that treat wounds (bandages, a potion, a medkit), calm for things that settle nerves (a drink, tea, a cigarette, a sedative), else empty; value: what the item is roughly worth in {{currency}} by the price scale; items_used: consumables {{user}} used up. statuses: a condition that starts (on: true) or ends (on: false) for {{user}} or a character in THIS exchange and lasts beyond the moment: knocked out or put to sleep (asleep), tied up, netted or held (bound), drugged or bitten by something venomous (poisoned), a bleeding wound (bleeding), hypnotised, charmed or mind-controlled (charmed), dazed by a blow (stunned), unable to move (paralyzed), terrified (frightened), blinded, drained or cursed (weakened), properly drunk (drunk), under an aphrodisiac or a lust spell (aroused). Only what the text clearly shows; on: false when they are cured, freed, woken or it wears off. Never repeat a condition already listed in the game state; usually []. money_ops: ONLY when the reply (or an action of {{user}} that the reply accepts) explicitly shows money changing hands for {{user}}: a character pays or rewards {{user}}, {{user}} is paid for work, finds or loots cash, sells something, buys something, pays a fee, a fine or a bribe, gives money away, is robbed or loses it. One entry per event, amount in {{currency}} with its sign (+ received, - paid): the number stated in the text; if the text gives no number, estimate modestly from the price scale ({{scale}}). who = the character or place on the other side; why_ru = what it was for. No entry for promises, offers, prices merely mentioned, debts, wages not yet paid, or money that has not actually changed hands. Never report what the game has already counted: {{counted}}. Most exchanges have no money at all: use []. encounter: ONLY if this reply ends right as sex is starting or is being proposed (nsfw), or a fight / chase / tense standoff is breaking out (combat), and it is not already under way; else empty kind. by: who started it — char when the character made the first move or proposed it; forced: true only if the character is taking {{user}} without waiting for his agreement (pins him, pulls him in, won't take no for an answer). harm only for injuries NOT already resolved by a dice check this turn (or -1 for real rest/treatment). stress = how much of {{user}}'s strength this exchange drained (+) or gave back (-): +1 only for something truly draining (a real scare, a humiliation, a loss, hours of hard effort), +2 almost never; -1 for a calm, pleasant scene or a proper meal; -2 or -3 for real rest (a night of sleep, a bath, being cared for, sex that ends well); 0 for everything else, which is most exchanges. New goals only when {{user}} clearly commits to an objective; done/failed only when it clearly resolves. Clocks: tick an existing progress clock when the story clearly advances it; create a threat clock only for a new looming danger. Use empty arrays when nothing applies.` },
    extractor_format: { group: 'tracker', title: "Формат ответа учёта", desc: "", locked: true, parent: "extractor",
        text: `Reply with ONE line of minified JSON, nothing else:
{"minutes":int (in-story time this exchange took: talk 5-15, local travel 10-45, long tasks hours),"location_ru":"place in 2-4 Russian words","weather":"clear|rain|storm|snow|fog|ash|wind|blizzard|sandstorm","time_of_day":"day|night|dusk|dawn","indoor":bool,"mood":"calm|cozy|joy|romance|tension|combat|mystery|horror|sad|epic|passion|playful|dream|gloom|uncanny|festive|noir|neon|sacred|nightmare|wild|abyss|frost|rage|triumph|sleepy","intensity":0-1,"events":["hit"|"slash"|"gunshot"|"blood"|"explosion"|"shatter"|"quake"|"lightning"|"fire"|"ice"|"water"|"smoke"|"magic"|"dark"|"holy"|"heal"|"poison"|"kiss"|"heartbeat"|"coins"|"confetti"] (only what physically happens now, usually []),"scene_changed":bool,
"npcs":[{"name":"","present":bool,"start_trust":-40..40,"start_affection":0..70,"start_attraction":0..70,"start_openness":0..70,"trust":-6..6,"affection":-5..5,"attraction":-5..5,"lust":-40..40,"openness":0..3,"start_stage":0..8,"start_experience":"virgin|inexperienced|experienced|very|","start_pace":"fast|normal|slow","start_partners":int,"intimacy":["kiss"|"makeout"|"grope"|"hands"|"oral_her"|"oral_you"|"sex"|"anal"|"kink"],"protection":"condom|pill|other|none|","positions_ru":[],"place_ru":"","her_orgasm":0..3,"user_orgasm":0..3,"with_others":[{"partner":"","acts":[]}],"learned_about":[],"moment_ru":"","moment_en":"","feel_ru":"","feel_en":"","likes_ru":[],"weak_spots_ru":[],"limits_ru":[],"why_ru":"коротко"}],
"harm":-1|0|1,"stress":-3..2,"statuses":[{"who":"name, or {{user}}","id":"stunned|paralyzed|asleep|bound|charmed|frightened|blinded|weakened|poisoned|bleeding|drunk|aroused","on":bool}],"money_ops":[{"amount":int (+ received, - paid),"kind":"payment|reward|found|loot|wage|sale|gift|purchase|fee|loss|theft","who":"who paid or was paid, or empty","why_ru":"за что, 2-6 слов"}],"items_gained":[{"name_ru":"","skill":"might|finesse|insight|charm|resolve|lore|passion|","bonus":0|1|2,"consumable":bool,"effect":"heal|calm|","value":int,"qty":int}],"items_lost":[],"items_used":[{"name_ru":"","qty":int}],"encounter":{"kind":"nsfw|combat|","partner":"","by":"user|char","forced":bool},
"goals":[{"title_ru":"","status":"new|done|failed"}],
"clocks":[{"name":"","kind":"progress|threat","tick":1|2,"size":4|6|8}]}` },
    world: { group: 'world', title: "Старт мира: дата, место, деньги", desc: "При настройке игры определяет дату, место, валюту, стартовые деньги и масштаб цен.",
        text: `Decide when and where this roleplay starts, from the character card and the opening.

Character: {{char}}
Description: {{description}}
Scenario: {{scenario}}
Opening:
{{opening}}

Rules: if the story gives a date, year or season, use it. A modern real-world story with no date: today ({{today}}) or close to it, a time of day that fits the opening. A historical setting: a fitting real year. A fantasy or fictional world: a plausible year in that world's own reckoning, with the era name in "era" (e.g. for Equestria a year counted from Celestia's reign, for Middle-earth "Third Age"); month and day still a normal calendar date. Location: where the opening scene is, 2-4 Russian words. Currency: the world's money as a short symbol or word (₽, $, €, bits, gold, credits). Price scale: meal = what a simple meal costs in that currency, day_wage = what a day of ordinary work pays. Money: what {{user}} plausibly carries, by that scale (usually a few days' wages; more or less if the card says so).
{{format}}` },
    world_format: { group: 'world', title: "Формат ответа", desc: "", locked: true, parent: "world",
        text: `Reply with ONE line of JSON: {"date":"YYYY-MM-DD","time":"HH:MM","era":"","location_ru":"","currency":"","money":int,"meal":int,"day_wage":int,"why_ru":"коротко, почему так"}` },
    econ: { group: 'world', title: "Масштаб цен", desc: "Для старых сохранений: один раз определяет, сколько стоит обед и сколько платят за день работы.",
        text: `Set the price scale of this story world, in its own currency.
Setting: {{setting}}. Currency: {{currency}}. {{user}} carries {{money}} right now.
{{format}}` },
    econ_format: { group: 'world', title: "Формат ответа", desc: "", locked: true, parent: "econ",
        text: `Reply with ONE line of JSON: {"meal":int (price of a simple meal),"day_wage":int (pay for a day of ordinary work)}` },
    quest: { group: 'world', title: "Побочные задания", desc: "Время от времени придумывает задание, которое мир предлагает герою, и награду за него.",
        text: `Invent ONE side quest the world offers {{user}} in an interactive story, small and concrete (an errand, a favour, a mystery, a job, a rescue, a delivery, a rumour to chase), fitting the setting and the current situation, solvable in a few scenes.
Setting: {{setting}}. Time: {{time}}. Location: {{location}}. Known characters: {{npcs}}. {{user}}'s current goals: {{goals}}. Level {{level}}. Money: {{money}} {{currency}}. Price scale: {{scale}}.
The reward is concrete and comes from the giver: reward_money is what they pay on completion (0 for a pure favour; otherwise between half a day's wage and five days' wages by the price scale, more only for real danger). Paid jobs, deliveries and bounties are welcome when {{user}} is short of money.
{{format}}` },
    quest_format: { group: 'world', title: "Формат ответа", desc: "", locked: true, parent: "quest",
        text: `Reply with ONE line of JSON: {"title_ru":"короткое название задания","giver":"who offers it (a known character or a new minor one)","hook_en":"how it shows up in the story: 1-2 sentences for the narrator","reward_money":int,"reward_xp":3-8,"reward_ru":"награда словами, коротко"}` },
    schedule: { group: 'world', title: "Распорядок дня персонажа", desc: "Один раз на персонажа пишет его обычный день: где он и чем занят по часам.",
        text: `Write a believable daily routine for {{name}}{{card}}. Setting: {{setting}}{{era}}.
Cover the whole day (sleep included) for weekdays and weekend if they differ, 4-8 blocks. busy = true when they are working or tied up and can't just drop it.
{{format}}` },
    schedule_format: { group: 'world', title: "Формат ответа", desc: "", locked: true, parent: "schedule",
        text: `Reply with ONE line of JSON: {"schedule":[{"days":"all|weekdays|weekend","from":"HH:MM","to":"HH:MM","where_ru":"где, 1-3 слова","doing_ru":"что делает, 2-5 слов","doing_en":"what they do, short","busy":bool}]}` },
    shop: { group: 'world', title: "Магазин", desc: "По кнопке «Что можно купить здесь?» решает, есть ли рядом торговля, и составляет список товаров с ценами.",
        text: `Where can {{user}} buy things right now? Setting: {{setting}}. Time: {{time}}. Location: {{location}}. Currency: {{currency}}. {{user}} has {{money}}. Price scale: {{scale}}.
If there is no shop, stall or trader nearby, say where the nearest one is. Otherwise list 6-8 items that fit the place and the world, with fair prices by the price scale: useful gear that helps a skill (a weapon +1 might, lockpicks +1 finesse, fine clothes +1 charm, a talisman +1 resolve, a book or medkit +1 lore, perfume or a toy +1 passion; rare quality gear +2 and expensive), consumables (condoms, potions, bandages: consumable, qty; effect heal for things that treat wounds, calm for things that settle nerves), and one or two nice gifts for someone. At least two items must be affordable right now.
{{format}}` },
    shop_format: { group: 'world', title: "Формат ответа", desc: "", locked: true, parent: "shop",
        text: `Reply with ONE line of JSON: {"available":bool,"place_ru":"название места","note_ru":"если нет — где ближайший","items":[{"name_ru":"","desc_ru":"коротко","price":int,"skill":"might|finesse|insight|charm|resolve|lore|passion|","bonus":0|1|2,"consumable":bool,"effect":"heal|calm|","qty":int}]}` },
    enc_start_nsfw: { group: 'enc', title: "Сцена близости: начало", desc: "Когда начинается сцена, выбирает вариацию, участников и первые четыре карточки.",
        text: `An intimate scene is starting in an interactive story. Set it up as a mini-game.

Variations: duet (mutual lovemaking, both move toward the peak together — the default), duel (a playful or real contest of pleasure: whoever comes first loses — for succubi, rivals, bets, competitive or predatory characters), her_lead (she is dominant and in charge: {{user}} must please her and hold out until she allows), your_lead (she is submissive or asks {{user}} to take charge; {{user}} leads, her trust must hold).
Pick the variation that fits the character and the moment.{{forced}}

Character card ({{char}}):
{{card}}

Partner record:
{{partner_record}}
Last narration:
<narration>
{{narration}}
</narration>

{{format}}
participants: every partner actually in the scene (usually one; several only if the narration really has several).
prefs: her hidden tastes, true to the card, from these tags only: kiss, neck, ears, breasts, thighs, hands, oral, slow, fast, deep, gentle, rough, tease, dirty, praise, dominate, worship, bite, hair, eyes, ass, toys, restraint, risk.
{{cards}}{{eroge}}` },
    enc_start_nsfw_format: { group: 'enc', title: "Формат ответа", desc: "", locked: true, parent: "enc_start_nsfw",
        text: `Reply with ONE line of JSON:
{"variant":"duet|duel|her_lead|your_lead","participants":[{"name":"her name","power":1-3}],"partner":"her name","title_ru":"короткое название сцены","prefs":{"loves":[1-2 tags],"likes":[2-4 tags],"dislikes":[1-2 tags]},
"pose_ru":"текущая поза и действие прямо сейчас, 3-7 слов, например «Она сверху, медленно двигается» или «Прижата к стене, его рука под юбкой»","intent":{"who":"кто именно действует","ru":"что она/он сейчас собирается сделать, 4-10 слов","en":"what they are about to do, 1 short sentence, third person","power":1-3,"tags":[]},
"options":[{"say":bool,"ru":"короткая конкретная метка, 1-2 слова, до 16 символов («Подсечь», «За запястья», «Сбить темп»); для реплики — короткая фраза в «ёлочках», до 4 слов","detail_ru":"подробно по-русски, одно предложение: что именно делает герой и чем рискует (показывается на карточке под меткой, до 90 символов)","risk_ru":"1-3 слова о риске или отдаче, можно пусто","en":"*detailed, specific first-person action in English, 1-2 sentences grounded in the scene; write {target} where the target's name goes*","skill":"passion|charm|finesse|resolve|insight","power":1-3,"kind":"act|resist|redirect|obey|defy|please","tags":[1-3 tags],"stage":0-8,"limit":bool}]}` },
    enc_cards_nsfw: { group: 'enc', title: "Сцена близости: правила карточек", desc: "Какими должны быть четыре карточки хода.",
        text: `Options: exactly 4 cards of four DIFFERENT kinds. Think like a game designer: every card is a real choice with its own upside, built from something concrete in the latest narration (her body and what she just did, her clothes, the pose, the place, a prop, an item {{user}} carries, what {{user}} already knows she likes).
1. THE ACT (kind act): one specific caress or move at a specific place on her body; power 2, or power 3 for the bold one that can blow her away or break the mood.
2. READ HER (kind please; in "her rules" also obey): an attentive move that follows what she has shown she likes, or tries a new spot or a new tone to find out. When it lands, the next act lands harder.
3. TAKE THE RHYTHM (kind redirect or resist; defy when she holds {{user}} down): answer her announced move — turn it around, slow her, change the pose or the place, hold back when {{user}} is close. When it works, her move does not land and the next act lands harder.
4. WILDCARD: whatever the moment begs for — a change of position or place, clothes coming off or pushed aside, a game, a dare, a toy or an item, or a spoken line.
Use different skills across the four cards (passion = technique, charm = words, finesse = precise hands, resolve = holding out, insight = reading her) so {{user}}'s best skill is usable every round. Never repeat a move, a body part or a verb from an earlier round: each round the scene has moved on (the pose, what is undressed, how close each of them is), and the cards show it.
SPOKEN LINES: one or two of the four cards are things {{user}} SAYS, not does (say: true): a tease, a compliment, a command, a confession, a dirty promise, a question that makes her blush, a challenge; in his own voice, fitting the moment and the variation. For these, ru = the phrase itself in Russian in «ёлочках», at most 4 words ("«Ты дрожишь»"), and en = *the exact words in quotes, plus at most a short tag* (e.g. "I lean in. "You're shaking. I like that.""); skill charm (or passion for dirty talk, insight for a question that reads her). A spoken card can be any of the four styles.
Follow the variation: duel = every card fights for control (pin, steal the initiative, make her break first); her_lead = obey / please / defy with real stakes (defy can win her over or cost {{user}}); your_lead = {{user}} leads with care, reads her, asks, builds trust; bold cards risk her trust. {{user}}'s skill passion = technique, charm = words, finesse = precise hands, resolve = holding out, insight = reading her. power 1 = light, 3 = intense. stage = the ladder step the act belongs to; never offer acts more than one step above "ready now". limit: true only if it touches one of her limits. The intent is her next move toward {{user}}, building from the narration.` },
    enc_next_nsfw_format: { group: 'enc', title: "Формат ответа: сцена близости", desc: "", locked: true, parent: "enc_next",
        text: `Reply with ONE line of JSON: {"participants":[{"name":"","side":"enemy|ally|partner","power":1-3,"gone":bool,"bar":0 only if knocked out}],"pose_ru":"текущая поза и действие прямо сейчас, 3-7 слов, например «Она сверху, медленно двигается» или «Прижата к стене, его рука под юбкой»","intent":{"who":"кто именно действует","ru":"что она/он сейчас собирается сделать, 4-10 слов","en":"what they are about to do, 1 short sentence, third person","power":1-3,"tags":[]},
"options":[{"say":bool,"ru":"короткая конкретная метка, 1-2 слова, до 16 символов («Подсечь», «За запястья», «Сбить темп»); для реплики — короткая фраза в «ёлочках», до 4 слов","detail_ru":"подробно по-русски, одно предложение: что именно делает герой и чем рискует (показывается на карточке под меткой, до 90 символов)","risk_ru":"1-3 слова о риске или отдаче, можно пусто","en":"*detailed, specific first-person action in English, 1-2 sentences grounded in the scene; write {target} where the target's name goes*","skill":"passion|charm|finesse|resolve|insight","power":1-3,"kind":"act|resist|redirect|obey|defy|please","tags":[1-3 tags],"stage":0-8,"limit":bool}]}` },
    enc_classify_nsfw_format: { group: 'enc', title: "Формат ответа: сцена близости", desc: "", locked: true, parent: "enc_classify",
        text: `Reply with ONE line of JSON: {"ru":"1-2 слова, до 16 символов","en":"the move, 1-2 specific sentences","skill":"passion|charm|finesse|resolve|insight","power":1-3,"kind":"act|resist|redirect|obey|defy|please","tags":[from: kiss, neck, ears, breasts, thighs, hands, oral, slow, fast, deep, gentle, rough, tease, dirty, praise, dominate, worship, bite, hair, eyes, ass, toys, restraint, risk],"stage":0-8,"limit":bool}` },
    enc_start_combat: { group: 'enc', title: "Бой: начало", desc: "Когда начинается бой, выбирает вариацию, участников и первые четыре карточки.",
        text: `An action encounter is starting in an interactive story. Set it up as a mini-game.

Variations: fight (a physical fight), chase (someone runs, someone pursues), standoff (a tense confrontation of nerves, threats or words).
Pick the variation that fits the character and the moment.{{forced}}

Character card ({{char}}):
{{card}}

Last narration:
<narration>
{{narration}}
</narration>

{{format}}
participants: EVERY character actually in the fight from the narration, one entry each (3 goblins = 3 entries "Гоблин 1"..., or "Гоблины ×3" if truly indistinguishable); enemies side "enemy"; companions fighting on {{user}}'s side (a sorceress, a guard) side "ally"; power = how dangerous each one is.
{{cards}}{{eroge}}` },
    enc_start_combat_format: { group: 'enc', title: "Формат ответа", desc: "", locked: true, parent: "enc_start_combat",
        text: `Reply with ONE line of JSON:
{"variant":"fight|chase|standoff","participants":[{"name":"1-3 words","side":"enemy|ally","power":1-3}],"partner":"opponent name, 1-3 words","title_ru":"короткое название сцены","power":1-3 (opponent strength: 1 weak, 2 even match, 3 dangerous),"role":"chaser|fleeing",
"pose_ru":"положение сейчас, 3-7 слов, например «Сцепились у стойки»","intent":{"who":"кто именно действует","ru":"что она/он сейчас собирается сделать, 4-10 слов","en":"what they are about to do, 1 short sentence, third person","power":1-3,"inflict":"condition this move leaves on its victim if it lands, or empty","target":"an ally's name if the move is aimed at them, else empty"},
"options":[{"say":bool,"ru":"короткая конкретная метка, 1-2 слова, до 16 символов («Подсечь», «За запястья», «Сбить темп»); для реплики — короткая фраза в «ёлочках», до 4 слов","detail_ru":"подробно по-русски, одно предложение: что именно делает герой и чем рискует (показывается на карточке под меткой, до 90 символов)","risk_ru":"1-3 слова о риске или отдаче, можно пусто","en":"*detailed, specific first-person action in English, 1-2 sentences grounded in the scene; write {target} where the target's name goes*","skill":"might|finesse|insight|charm|resolve|lore","power":1-3,"kind":"attack|defend|trick|flee|talk|item","item":"item name if it uses one","inflict":"stunned|paralyzed|asleep|bound|charmed|frightened|blinded|weakened|poisoned|bleeding|drunk|aroused| (empty unless the move really leaves the target in that condition)"}]}` },
    enc_cards_combat: { group: 'enc', title: "Бой: правила карточек", desc: "Какими должны быть четыре карточки хода.",
        text: `Options: exactly 4 cards of four DIFFERENT kinds. Think like a game designer: every card is a real choice with its own upside, built from something concrete in the latest narration (the opponent's announced move, a named object, the terrain, a wound, an ally, an item {{user}} carries).
1. STRIKE (kind attack): one specific blow at a specific opening; power 2, or power 3 for an all-in that hits hard and is harder to land.
2. ANSWER (kind defend): the exact counter to what the opponent is about to do — parry, sidestep, catch the arm, drop flat, put something between them. When it works the hit is avoided and the opponent is left open.
3. CLEVER PLAY (kind trick): turn a named thing in the scene against them (never generic "use the environment"). When it works the opponent is left open for the next strike.
4. WILDCARD, whichever fits best: a spoken line (kind talk), an item {{user}} carries (kind item, name it), a move together with an ally, or a way out (kind flee) when {{user}} is hurt or outnumbered.
Use different skills across the four cards where the fiction allows (might = force, finesse = speed and precision, insight = reading the opponent, charm = words, resolve = nerve, lore = knowledge) so {{user}}'s best skill is usable every round. Never repeat a move from an earlier round: each round the fight has changed (positions, wounds, what broke, who fell), and the cards show it.
SPOKEN LINES: one of the four cards (two in a standoff) is something {{user}} SAYS (say: true): a taunt, a threat, a bluff, a bargain, a calm word, kind talk; ru = the phrase in Russian in «ёлочках», at most 4 words; en = *the exact words in quotes, plus at most a short tag*; skill charm (bluff, persuade), resolve (calm, threat) or insight.
The intent is the opponent's next move, telegraphed so {{user}} can react: specific and physical ("swings the bench at his legs"), never vague. CONDITIONS: a card may carry "inflict" when the move would really leave the target that way — a blow to the head or a thrown stool: stunned; a net, a rope, a pin against the wall: bound; sand, ale or a lantern in the eyes: blinded; a real threat or a show of force: frightened; a poisoned blade or dart: poisoned; a deep cut: bleeding; a sleeping draught: asleep; a spell or a pendulum: charmed. At most one or two such cards per round, and say on the card what it does. The opponent's intent may carry "inflict" the same way (a net, a venomous bite, a hypnotic stare, a paralysing touch), with "target" when it is aimed at an ally. A character under a condition does only what it allows.` },
    enc_next_combat_format: { group: 'enc', title: "Формат ответа: бой", desc: "", locked: true, parent: "enc_next",
        text: `Reply with ONE line of JSON: {"participants":[{"name":"","side":"enemy|ally|partner","power":1-3,"gone":bool,"bar":0 only if knocked out}],"pose_ru":"положение сейчас, 3-7 слов, например «Сцепились у стойки»","intent":{"who":"кто именно действует","ru":"что она/он сейчас собирается сделать, 4-10 слов","en":"what they are about to do, 1 short sentence, third person","power":1-3,"inflict":"condition this move leaves on its victim if it lands, or empty","target":"an ally's name if the move is aimed at them, else empty"},
"options":[{"say":bool,"ru":"короткая конкретная метка, 1-2 слова, до 16 символов («Подсечь», «За запястья», «Сбить темп»); для реплики — короткая фраза в «ёлочках», до 4 слов","detail_ru":"подробно по-русски, одно предложение: что именно делает герой и чем рискует (показывается на карточке под меткой, до 90 символов)","risk_ru":"1-3 слова о риске или отдаче, можно пусто","en":"*detailed, specific first-person action in English, 1-2 sentences grounded in the scene; write {target} where the target's name goes*","skill":"might|finesse|insight|charm|resolve|lore","power":1-3,"kind":"attack|defend|trick|flee|talk|item","item":"item name if it uses one","inflict":"stunned|paralyzed|asleep|bound|charmed|frightened|blinded|weakened|poisoned|bleeding|drunk|aroused| (empty unless the move really leaves the target in that condition)"}]}` },
    enc_classify_combat_format: { group: 'enc', title: "Формат ответа: бой", desc: "", locked: true, parent: "enc_classify",
        text: `Reply with ONE line of JSON: {"ru":"1-2 слова, до 16 символов","en":"the move, 1-2 specific sentences","skill":"might|finesse|insight|charm|resolve|lore","power":1-3,"kind":"attack|defend|trick|flee|talk|item","item":""}` },
    enc_cards_labels: { group: 'enc', title: "Карточки: подписи и текст хода", desc: "Общие правила для подписей карточек и текста, который уходит в историю.",
        text: `Every card is {{user}}'s OWN action, in first person as {{user}} ("I…"), even when the danger is aimed at someone else (then the card is how {{user}} steps in); allies and partners act on their own in the narration, never on a card, and {{user}} is never listed among the participants. Labels ("ru"): Russian, SHORT and CONCRETE: 1-2 words, at most 16 characters, a specific verb with its object rather than a generic one ("Подсечь", "Швырнуть кружку", "За запястья", "В шею", "Сбить темп" — not "Атаковать", "Ласкать", "Действовать"); spoken cards are a short phrase in «ёлочках», at most 4 words. "detail_ru" is shown on the card under the label: one short Russian sentence saying exactly what {{user}} does. All the detail goes into "en": it is sent as {{user}}'s message, so make it a specific, vivid first-person action (1-2 sentences) using details of the scene; use {target} for the name of whoever the move is aimed at when there are several characters. "risk_ru": 1-3 words about the gamble or the payoff ("рискованно", "может понравиться", "она может отказать", "надёжно"), different on each card.` },
    enc_next: { group: 'enc', title: "Следующий раунд", desc: "После каждого ответа в сцене или бою готовит новые четыре карточки.",
        text: `Mini-game round {{round}} of {{variant}} between {{user}} and {{partner}}.
{{sheet}}
Bars: {{bars}}. Last moves: {{last_moves}}.

Latest narration:
<narration>
{{narration}}
</narration>

Participants now: {{participants}}. Selected target: {{target}}.
{{format}}
participants: include only NEW arrivals, and anyone knocked out, fled or gone (gone:true or bar 0); otherwise [].
{{cards}}{{eroge}}{{forced}}` },
    enc_classify: { group: 'enc', title: "Свой ход игрока", desc: "Когда игрок пишет ход сам, превращает его в карточку с навыком и силой.",
        text: `In {{variant}} mini-game, {{user}} wrote their own move. Classify it as one option card.
{{sheet}}
Narration: {{narration}}
{{user}}'s move: {{action}}
Selected target: {{target}}.
{{format}}` },
};

let overrides = {};
/** Player's edited texts: { id: text }. Unknown ids are ignored. */
export function setOverrides(o) { overrides = (o && typeof o === 'object') ? o : {}; }
export const defaultText = (id) => PROMPTS[id]?.text ?? '';
export const isChanged = (id) => typeof overrides[id] === 'string' && overrides[id] !== defaultText(id);
export const textOf = (id) => (typeof overrides[id] === 'string' ? overrides[id] : defaultText(id));
export const varsOf = (text) => [...new Set([...String(text || '').matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))];
/** Placeholders the default has and this text lost (the model would not get that piece). */
export const missingVars = (id, text) => varsOf(defaultText(id)).filter(v => !varsOf(text).includes(v));

/** Fills {{placeholders}} from vars; unknown ones are left as they are. */
export function render(id, vars = {}) {
    return textOf(id).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars && vars[k] != null ? String(vars[k]) : m));
}
