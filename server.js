require('dotenv').config();
const express = require('express');
const pool = require('./db');
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));

// Homepage — just list some books for now
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT book_id, title, authors, image_url FROM books LIMIT 20');
    res.render('index', { books: result.rows });
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

    res.render('book-details', { book, recommendations: recResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});