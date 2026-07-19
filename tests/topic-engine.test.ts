import assert from "node:assert/strict";
import test from "node:test";
import { TOPICS, type SpeechTopic } from "../app/data/topics";
import {
  createTopicPool,
  createSeededRandom,
  drawHand,
  recordLockedTopic,
} from "../app/lib/topicEngine";

function predictableRandom() {
  let index = 0;
  const values = [0.2, 0.8, 0.4, 0.6, 0.1, 0.9, 0.3, 0.7];

  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

test("draws from a shuffled pool without immediate repeats", () => {
  const random = predictableRandom();
  let state = createTopicPool(TOPICS, random);
  const seenIds = new Set<string>();

  for (let index = 0; index < 8; index += 1) {
    const result = drawHand(state, TOPICS, { size: 3, random });
    assert.equal(result.hand.length, 3);

    for (const topic of result.hand) {
      assert.equal(seenIds.has(topic.id), false);
      seenIds.add(topic.id);
    }

    state = result.state;
  }
});

test("can create deterministic shuffled pools for server hydration", () => {
  const first = createTopicPool(TOPICS, createSeededRandom(42));
  const second = createTopicPool(TOPICS, createSeededRandom(42));

  assert.deepEqual(first.poolIds, second.poolIds);
});

test("avoids showing the last locked category first when alternatives exist", () => {
  const topics: SpeechTopic[] = [
    {
      id: "debate-a",
      prompt: "Debate first",
      category: "Debate",
      difficulty: "warm-up",
      trains: "test",
      why: "test",
      framework: "test",
      timeSeconds: 60,
      tags: [],
    },
    {
      id: "debate-b",
      prompt: "Debate second",
      category: "Debate",
      difficulty: "warm-up",
      trains: "test",
      why: "test",
      framework: "test",
      timeSeconds: 60,
      tags: [],
    },
    {
      id: "tech-a",
      prompt: "Tech first",
      category: "Tech",
      difficulty: "warm-up",
      trains: "test",
      why: "test",
      framework: "test",
      timeSeconds: 60,
      tags: [],
    },
  ];

  const lockedState = recordLockedTopic(
    {
      poolIds: ["debate-a", "tech-a", "debate-b"],
      spentIds: [],
      lastLockedCategory: null,
      reshuffleCount: 0,
    },
    topics[0],
  );
  const result = drawHand(lockedState, topics, { size: 2, random: () => 0 });

  assert.equal(result.hand[0].category, "Tech");
});

test("reshuffles only after the full pool has been spent", () => {
  const topics = TOPICS.slice(0, 4);
  const state = createTopicPool(topics, () => 0);

  const first = drawHand(state, topics, { size: 4, random: () => 0 });
  assert.equal(first.state.poolIds.length, 0);
  assert.equal(first.state.reshuffleCount, 0);

  const second = drawHand(first.state, topics, { size: 1, random: () => 0 });
  assert.equal(second.hand.length, 1);
  assert.equal(second.state.reshuffleCount, 1);
});
