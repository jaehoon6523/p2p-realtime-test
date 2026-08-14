'use strict';

// Canonical gameplay ability data. Keep runtime/validator numbers here only.
// TODO(XML): replace this JS data source with an Ability/Component XML loader that emits the same immutable shape.
const ABILITY_DEFINITIONS = Object.freeze({
    Q:Object.freeze({id:'basic_attack',key:'Q',kind:'shoot',cooldownMs:500,castMs:0,recoveryMs:200,range:230}),
    W:Object.freeze({id:'long_shot',key:'W',kind:'shoot',cooldownMs:2000,castMs:200,recoveryMs:200,range:460}),
    E:Object.freeze({id:'dash',key:'E',kind:'dash',cooldownMs:3000,castMs:200,recoveryMs:200,distance:150}),
});
const ABILITY_BY_ID = Object.freeze(Object.fromEntries(Object.values(ABILITY_DEFINITIONS).map(v=>[v.id,v])));
