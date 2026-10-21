import sys, asyncio, pathlib
from playwright.async_api import async_playwright
ROOT = pathlib.Path(__file__).resolve().parent.parent
NM = ROOT / 'node_modules/js-aruco2/src'
OUT = ROOT / 'test'
async def route(r):
    u = r.request.url
    if 'js-aruco2' in u:
        await r.fulfill(path=str(NM / u.split('/src/')[1]), content_type='application/javascript')
    elif 'fonts.g' in u:
        await r.abort()
    else:
        await r.continue_()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args=[
            '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={OUT/"fake.y4m"}'])
        for name, vp in (('phone', {'width': 390, 'height': 844}), ('desk', {'width': 1280, 'height': 800})):
            ctx = await b.new_context(viewport=vp, device_scale_factor=2 if name == 'phone' else 1, permissions=['camera'])
            pg = await ctx.new_page()
            errs = []
            pg.on('console', lambda m: errs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
            pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
            await pg.route('**/*', route)
            await pg.goto((ROOT / 'index.html').as_uri())
            await pg.wait_for_timeout(2500)
            await pg.screenshot(path=str(OUT / f'shot-{name}-photo.png'))
            await pg.click('#mode-sandbox'); await pg.wait_for_timeout(400)
            await pg.click('.move[data-key="sail2"]'); await pg.wait_for_timeout(300)
            await pg.screenshot(path=str(OUT / f'shot-{name}-sandbox.png'))
            await pg.click('#mode-live'); await pg.wait_for_timeout(300)
            await pg.click('#live-start'); await pg.wait_for_timeout(3500)
            await pg.screenshot(path=str(OUT / f'shot-{name}-live.png'))
            txt = await pg.inner_text('#panel')
            print(name, 'panel:', ' | '.join(txt.split('\n')[:14]))
            print(name, 'errors:', errs[:8])
            await ctx.close()
        await b.close()
asyncio.run(main())
