require('dotenv').config();
const express = require('express');
const pool = require('./db');
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));
const session = require('express-session');
const bcrypt = require('bcrypt');

app.use(express.urlencoded({ extended: true })); // needed to read form data
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
}));
app.use((req, res, next) => {
  res.locals.userId = req.session.userId;
  res.locals.username = req.session.username;
  next();
});

// Homepage 
app.get('/', async (req, res) => {
  try {
    const booksResult = await pool.query('SELECT book_id, title, authors, image_url FROM books LIMIT 20');

    let currentlyReading = [];
    if (req.session.userId) {
      const readingResult = await pool.query(`
        SELECT ub.current_page, ub.total_pages, b.book_id, b.title, b.image_url
        FROM user_books ub
        JOIN books b ON b.book_id = ub.book_id
        WHERE ub.user_id = $1 AND ub.status = 'reading'
        ORDER BY ub.updated_at DESC
      `, [req.session.userId]);
      currentlyReading = readingResult.rows;
    }

    res.render('index', { books: booksResult.rows, currentlyReading });
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong');
  }
});

// Book details + recommendations
app.get('/books/:id', async (req, res) => {
  try {
    const bookId = req.params.id;

    const bookResult = await pool.query('SELECT * FROM books WHERE book_id = $1', [bookId]);
    const book = bookResult.rows[0];

    if (!book) return res.status(404).send('Book not found');
        let userBook = null;
    if (req.session.userId) {
      const ubResult = await pool.query(
        'SELECT * FROM user_books WHERE user_id = $1 AND book_id = $2',
        [req.session.userId, bookId]
      );
      userBook = ubResult.rows[0] || null;
    }

    const recResult = await pool.query(`
      SELECT b.book_id, b.title, b.authors, b.image_url, SUM(bt2.count) AS similarity_score
      FROM book_tags bt1
      JOIN book_tags bt2 ON bt1.tag_id = bt2.tag_id AND bt1.goodreads_book_id != bt2.goodreads_book_id
      JOIN books b ON b.goodreads_book_id = bt2.goodreads_book_id
      WHERE bt1.goodreads_book_id = $1
      GROUP BY b.book_id, b.title, b.authors, b.image_url
      ORDER BY similarity_score DESC
      LIMIT 10
    `, [book.goodreads_book_id]);
        const reviewsResult = await pool.query(`
      SELECT r.rating, r.review_text, r.created_at, u.username
      FROM reviews r
      JOIN users u ON u.user_id = r.user_id
      WHERE r.book_id = $1
      ORDER BY r.created_at DESC
    `, [bookId]);

    let myReview = null;
    if (req.session.userId) {
      const myReviewResult = await pool.query(
        'SELECT * FROM reviews WHERE user_id = $1 AND book_id = $2',
        [req.session.userId, bookId]
      );
      myReview = myReviewResult.rows[0] || null;
    }

        res.render('book-details', { book, recommendations: recResult.rows, userBook, reviews: reviewsResult.rows, myReview });
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
// Show signup form
app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

// Handle signup
app.post('/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)',
      [username, email, hash]
    );
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('signup', { error: 'Username or email already taken' });
  }
});

// Show login form
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Handle login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) return res.render('login', { error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.render('login', { error: 'Invalid email or password' });

    req.session.userId = user.user_id;
    req.session.username = user.username;
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong' });
  }
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Add or update a book's status on a user's shelf
app.post('/books/:id/shelf', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');

  const bookId = req.params.id;
  const { status, total_pages } = req.body;

  try {
    await pool.query(`
      INSERT INTO user_books (user_id, book_id, status, total_pages, started_at)
      VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'reading' THEN NOW() ELSE NULL END)
      ON CONFLICT (user_id, book_id)
      DO UPDATE SET status = $3, total_pages = COALESCE($4, user_books.total_pages), updated_at = NOW()
    `, [req.session.userId, bookId, status, total_pages || null]);

    res.redirect(`/books/${bookId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong');
  }
});
app.get('/profile', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');

  try {
    const result = await pool.query(`
      SELECT ub.status, b.book_id, b.title, b.authors, b.image_url, ub.current_page, ub.total_pages
      FROM user_books ub
      JOIN books b ON b.book_id = ub.book_id
      WHERE ub.user_id = $1
      ORDER BY ub.updated_at DESC
    `, [req.session.userId]);

    const shelves = { tbr: [], reading: [], read: [] };
    result.rows.forEach(row => shelves[row.status].push(row));

    res.render('profile', { shelves });
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong');
  }
});
app.post('/books/:id/progress', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const bookId = req.params.id;
  const { current_page } = req.body;

  try {
    await pool.query(`
      UPDATE user_books
      SET current_page = $1, updated_at = NOW()
      WHERE user_id = $2 AND book_id = $3
    `, [current_page, req.session.userId, bookId]);
    res.redirect(`/books/${bookId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong');
  }
});
// Submit or update a review
app.post('/books/:id/review', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const bookId = req.params.id;
  const { rating, review_text } = req.body;

  try {
    await pool.query(`
      INSERT INTO reviews (user_id, book_id, rating, review_text)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, book_id)
      DO UPDATE SET rating = $3, review_text = $4, created_at = NOW()
    `, [req.session.userId, bookId, rating, review_text]);

    res.redirect(`/books/${bookId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong');
  }
});