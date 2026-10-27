async page => {
 await page.reload();await page.getByRole('button',{name:'MoYu',exact:true}).click();
 await page.getByRole('tab',{name:'Overview',exact:true}).click();
 const leaders=page.locator('#stocks-page iframe[title="Leaders"]');
 await leaders.contentFrame().getByRole('tab',{name:'Biotech',exact:true}).click({timeout:20000});
 await leaders.contentFrame().getByText('AMGN',{exact:true}).first().waitFor({timeout:20000});
 const src=await leaders.getAttribute('src');
 const hash=decodeURIComponent(src.slice(src.indexOf('#')+1));
 const group=JSON.parse(hash).tabs.find(g=>g.title==='Biotech');
 if(!group||group.symbols.length!==15)throw new Error('Biotech list incomplete');
 const tickers=group.symbols.map(s=>s.s);
 for(const symbol of ['NASDAQ:AMGN','NASDAQ:MRNA','NASDAQ:SDGR','NASDAQ:IBB','AMEX:XBI']) {
   if(!tickers.includes(symbol))throw new Error('Missing '+symbol);
 }
 await page.getByRole('button',{name:'Open a stock',exact:true}).click();
 await page.getByRole('textbox',{name:'Search stocks',exact:true}).fill('PCVX');
 await page.getByRole('button',{name:'NASDAQ:PCVX Vaxcyte United States',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 return {category:'Biotech',uniqueSymbols:tickers,search:'PCVX available'};
}
