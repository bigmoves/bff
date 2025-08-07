import type { Agent } from "@atproto/api";
import { TID } from "@atproto/common";
import { stringifyLex } from "@atproto/lexicon";
import { AtUri } from "@atproto/syntax";
import { assert } from "@std/assert";
import type { BffConfig } from "../types.d.ts";
import type { IndexService } from "./indexing.ts";

export function createRecord(
  agent: Agent | undefined,
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (
    collection: string,
    data: { [_ in string]: unknown },
    self: boolean = false,
  ) => {
    const did = agent?.assertDid;
    const rkey = self ? "self" : TID.nextStr();

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    const record = {
      $type: collection,
      ...data,
    };

    assert(cfg.lexicons.assertValidRecord(collection, record));

    const response = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection,
      rkey,
      record,
      validate: false,
    });

    const uri = `at://${did}/${collection}/${rkey}`;
    indexService.insertRecord({
      uri,
      cid: response.data.cid.toString(),
      did,
      collection,
      json: stringifyLex(record),
      indexedAt: new Date().toISOString(),
    });
    return uri;
  };
}

export function createRecords(
  agent: Agent | undefined,
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (creates: {
    collection: string;
    rkey?: string;
    data: { [_ in string]: unknown };
  }[]) => {
    const did = agent?.assertDid;
    if (!did) throw new Error("Agent is not authenticated");

    const records = creates.map(({ collection, data }) => ({
      $type: collection,
      ...data,
    }));

    creates = creates.map((c) => ({
      ...c,
      rkey: c.rkey || TID.nextStr(),
    }));

    creates.forEach(({ collection }, i) => {
      assert(cfg.lexicons.assertValidRecord(collection, records[i]));
    });

    const results: string[] = [];

    try {
      const response = await agent.com.atproto.repo.applyWrites({
        repo: did,
        validate: false,
        writes: creates.map(({ collection, rkey, data }) => ({
          $type: "com.atproto.repo.applyWrites#create",
          collection,
          rkey,
          value: data,
        })),
      });

      const cidMap = new Map<string, string>();
      for (const result of response?.data?.results ?? []) {
        if (result.$type === "com.atproto.repo.applyWrites#createResult") {
          cidMap.set(result.uri, result.cid);
        }
      }

      for (let i = 0; i < creates.length; i++) {
        const { collection, rkey } = creates[i];
        const record = records[i];

        const uri = `at://${did}/${collection}/${rkey}`;

        indexService.insertRecord({
          uri,
          cid: cidMap.get(uri) ?? "",
          did,
          collection,
          json: stringifyLex(record),
          indexedAt: new Date().toISOString(),
        });

        results.push(uri);
      }
    } catch (error) {
      console.error("Error creating records:", error);
      throw new Error("Failed to create records");
    }
    return results;
  };
}

export function updateRecord(
  agent: Agent | undefined,
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (
    collection: string,
    rkey: string,
    data: { [_ in string]: unknown },
  ) => {
    const did = agent?.assertDid;

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    const record = {
      $type: collection,
      ...data,
    };

    assert(cfg.lexicons.assertValidRecord(collection, record));

    const response = await agent.com.atproto.repo.putRecord({
      repo: agent.assertDid,
      collection,
      rkey,
      record,
      validate: false,
    });

    const uri = `at://${did}/${collection}/${rkey}`;
    indexService.updateRecord({
      uri,
      cid: response.data.cid.toString(),
      did,
      collection,
      json: stringifyLex(record),
      indexedAt: new Date().toISOString(),
    });
    return uri;
  };
}

export function updateRecords(
  agent: Agent | undefined,
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (updates: {
    collection: string;
    rkey: string;
    data: { [_ in string]: unknown };
  }[]) => {
    const did = agent?.assertDid;
    if (!did) throw new Error("Agent is not authenticated");

    const records = updates.map(({ collection, data }) => ({
      $type: collection,
      ...data,
    }));

    updates.forEach(({ collection }, i) => {
      assert(cfg.lexicons.assertValidRecord(collection, records[i]));
    });

    const results: string[] = [];

    try {
      const response = await agent.com.atproto.repo.applyWrites({
        repo: did,
        validate: false,
        writes: updates.map(({ collection, rkey, data }) => ({
          $type: "com.atproto.repo.applyWrites#update",
          collection,
          rkey,
          value: data,
        })),
      });

      const cidMap = new Map<string, string>();
      for (const result of response?.data?.results ?? []) {
        if (result.$type === "com.atproto.repo.applyWrites#updateResult") {
          cidMap.set(result.uri, result.cid);
        }
      }

      for (let i = 0; i < updates.length; i++) {
        const { collection, rkey } = updates[i];
        const record = records[i];

        const uri = `at://${did}/${collection}/${rkey}`;

        indexService.updateRecord({
          uri,
          cid: cidMap.get(uri) ?? "",
          did,
          collection,
          json: stringifyLex(record),
          indexedAt: new Date().toISOString(),
        });

        results.push(uri);
      }
    } catch (error) {
      console.error("Error updating records:", error);
      throw new Error("Failed to update records");
    }
    return results;
  };
}

export function deleteRecord(
  agent: Agent | undefined,
  indexService: IndexService,
) {
  return async (uri: string) => {
    const did = agent?.assertDid;

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    const atUri = new AtUri(uri);
    await agent.com.atproto.repo.deleteRecord({
      repo: agent.assertDid,
      collection: atUri.collection,
      rkey: atUri.rkey,
    });
    indexService.deleteRecord(atUri.toString());
  };
}
