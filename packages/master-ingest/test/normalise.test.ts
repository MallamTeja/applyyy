/* Normalisation, tested on the two things it actually has to get right: the
 * symbols it must PRESERVE and the noise it must REMOVE.
 *
 * Both halves are load-bearing and they pull in opposite directions, which is
 * why there are two functions rather than one. A test suite that only checked
 * the removals would pass with a normaliser that stripped everything - and that
 * normaliser collapses C, C++ and C# onto one match key.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { normaliseKey, tokenise, tokenSet } from '../src/index.ts';

describe('normaliseKey preserves identity', () => {
  /* THE CASE THAT MOTIVATES HAVING TWO FUNCTIONS. If these three collapse, all
     three keys go ambiguous and every id under them churns on an upload that
     changed nothing. */
  it('keeps C, C++ and C# distinct', () => {
    const keys = new Set([normaliseKey('C'), normaliseKey('C++'), normaliseKey('C#')]);
    assert.equal(keys.size, 3);
  });

  it('keeps dotted and slashed names distinct', () => {
    assert.notEqual(normaliseKey('Node.js'), normaliseKey('Nodejs'));
    assert.notEqual(normaliseKey('CI/CD'), normaliseKey('CICD'));
  });

  /* TWIN to the preservation tests: it must still fold what is genuinely noise,
     or "preserves identity" would be satisfied by a function that returns its
     input unchanged. */
  it('folds case and collapses whitespace', () => {
    assert.equal(normaliseKey('  PostgreSQL  '), 'postgresql');
    assert.equal(normaliseKey('Northwind\n  Systems'), 'northwind systems');
  });

  it('folds the substitutions a document pipeline makes on its own', () => {
    /* Curly apostrophe, en dash and non-breaking space all arrive from Overleaf
       without anyone typing them. */
    assert.equal(normaliseKey('Teja’s'), normaliseKey("Teja's"));
    assert.equal(normaliseKey('2024–2027'), normaliseKey('2024-2027'));
    assert.equal(normaliseKey('40 %'), normaliseKey('40 %'));
    /* A zero-width joiner inside a word must vanish without splitting it. */
    assert.equal(normaliseKey('Post​greSQL'), 'postgresql');
  });
});

describe('the line-wrap hyphen fold', () => {
  /* MEASURED IN THE REAL RESUME: justified LaTeX hyphenates across line breaks
     in six places. Where it breaks depends on every word before the break, so
     editing one early word moves the hyphen and changes the token set of text
     that was never touched - churning an id for a reason invisible in the
     document. */
  it('rejoins a word broken across a line', () => {
    assert.equal(normaliseKey('Expe-\nrienced in RAG'), 'experienced in rag');
    assert.equal(normaliseKey('Post-  greSQL'), 'postgresql');
  });

  it('removes a soft hyphen without splitting the word', () => {
    assert.equal(normaliseKey('Post­greSQL'), 'postgresql');
  });

  /* TWIN - and it is the important one, because an over-eager fold would break
     every hyphenated compound and every dash separator in the document. */
  it('leaves real hyphenated compounds and dash separators alone', () => {
    assert.equal(normaliseKey('event-driven'), 'event-driven');
    assert.equal(normaliseKey('end-to-end'), 'end-to-end');
    /* This one is load-bearing for the project match key: the separator in
       "One-on-One - AI-Powered Learning Platform" must survive, or the key can
       no longer be truncated at it. */
    assert.equal(normaliseKey('One-on-One – AI-Powered'), 'one-on-one - ai-powered');
  });

  /* The fold makes the SAME text produce the SAME tokens whether or not the
     wrap moved, which is the entire property it exists for. */
  it('makes a moved line-wrap invisible to the tokeniser', () => {
    const wrappedEarly = tokenSet('Integrated LLM APIs with RAG pipe-\nlines into billing.');
    const wrappedLate = tokenSet('Integrated LLM APIs with RAG pipelines into bill-\ning.');
    assert.deepEqual([...wrappedEarly].sort(), [...wrappedLate].sort());
  });
});

describe('tokenise for similarity', () => {
  it('keeps numbers, because the numbers are what a fact-check turns on', () => {
    assert.deepEqual(tokenise('Cut p95 latency 40%'), ['cut', 'p95', 'latency', '40']);
  });

  it('discards punctuation so a rewording is not penalised for a comma', () => {
    assert.deepEqual(tokenise('latency, throughput'), tokenise('latency throughput'));
  });

  it('deduplicates in the set form, because repetition is not evidence', () => {
    /* A bullet that says "service" twice is not twice as much about services,
       and counting it twice would let a repeated filler word carry a match. */
    assert.equal(tokenSet('service service service').size, 1);
    assert.equal(tokenise('service service service').length, 3);
  });
});
