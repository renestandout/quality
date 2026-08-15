import laravel from './laravel.mjs'

// PHP ohne Laravel: identische Werkzeuge, nur ohne artisan-Testlauf.
export default {
  ...laravel,
  name: 'php',
  test(ctx) {
    return laravel.test({ ...ctx, dir: ctx.dir })
  },
}
