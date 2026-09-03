require('dotenv').config();
const pool = require('./db');
const fs = require('fs');

const logFile = 'precompute-log.txt';
fs.writeFileSync(logFile, ''); // clear old log

function log(msg) {
  fs.appendFileSync(logFile, msg + '\n');
}

log('Script started');

process.on('uncaughtException', (err) => {
  log('UNCAUGHT EXCEPTION: ' + err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  log('UNHANDLED REJECTION: ' + (err.stack || err));
  process.exit(1);
});
async function run() {
  log('Loading ratings from database...');

  // Load all ratings (goodbooks-10k table + your own reviews, combined)
  const ratingsResult = await pool.query(`
    SELECT user_id, book_id, rating FROM ratings
    UNION ALL
    SELECT user_id, book_id, rating FROM reviews
  `);
  const allRatings = ratingsResult.rows;
  log(`Loaded ${allRatings.length} ratings.`);

  // Group ratings by user: userId -> [{book_id, rating}, ...]
  const userRatings = new Map();
  for (const r of allRatings) {
    if (!userRatings.has(r.user_id)) userRatings.set(r.user_id, []);
    userRatings.get(r.user_id).push({ book_id: r.book_id, rating: r.rating });
  }

  // Track dot products between book pairs, and each book's vector "length" (norm)
  const dotProducts = new Map(); // key: "bookA-bookB" -> sum
  const bookNormSquared = new Map(); // book_id -> sum of rating^2

  log('Computing similarity data...');
  let processedUsers = 0;
const MAX_BOOKS_PER_USER = 50;
  for (let books of userRatings.values()) {
    // For each pair of books this user rated, accumulate dot product
      if (books.length > MAX_BOOKS_PER_USER) {   // ← ADD THIS BLOCK, right after the loop opens
      books = [...books].sort(() => Math.random() - 0.5).slice(0, MAX_BOOKS_PER_USER);
    }
    for (let i = 0; i < books.length; i++) {
        
      const a = books[i];

      // Accumulate this book's own norm contribution
      bookNormSquared.set(a.book_id, (bookNormSquared.get(a.book_id) || 0) + a.rating * a.rating);

      for (let j = i + 1; j < books.length; j++) {
        const b = books[j];
        const key = a.book_id < b.book_id ? `${a.book_id}-${b.book_id}` : `${b.book_id}-${a.book_id}`;
        dotProducts.set(key, (dotProducts.get(key) || 0) + a.rating * b.rating);
      }
    }
    processedUsers++;
    if (processedUsers % 5000 === 0) log(`Processed ${processedUsers} users...`);
  }

  log(`Found ${dotProducts.size} book pairs with shared raters.`);
  log('Computing final similarity scores...');

  // Compute cosine similarity for each pair, keep track of top matches per book
  const topSimilar = new Map(); // book_id -> [{book_id, score}, ...]

  for (const [key, dot] of dotProducts.entries()) {
    const [aStr, bStr] = key.split('-');
    const a = parseInt(aStr);
    const b = parseInt(bStr);

    const normA = Math.sqrt(bookNormSquared.get(a) || 0);
    const normB = Math.sqrt(bookNormSquared.get(b) || 0);
    if (normA === 0 || normB === 0) continue;

    const score = dot / (normA * normB);

    // Store both directions (A is similar to B, and B is similar to A)
    if (!topSimilar.has(a)) topSimilar.set(a, []);
    if (!topSimilar.has(b)) topSimilar.set(b, []);
    topSimilar.get(a).push({ book_id: b, score });
    topSimilar.get(b).push({ book_id: a, score });
  }

  log('Saving top 10 similar books per book to database...');

  await pool.query('DELETE FROM book_similarities'); // clear old results before re-inserting

  let saved = 0;
  for (const [bookId, matches] of topSimilar.entries()) {
    matches.sort((x, y) => y.score - x.score);
    const top10 = matches.slice(0, 10);

    for (const m of top10) {
      await pool.query(
        'INSERT INTO book_similarities (book_id, similar_book_id, score) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [bookId, m.book_id, m.score]
      );
      saved++;
    }
  }

  log(`Done. Saved ${saved} similarity rows.`);
  await pool.end();
}

run().catch(err => {
  log('ERROR: ' + err.stack);
  process.exit(1);
});